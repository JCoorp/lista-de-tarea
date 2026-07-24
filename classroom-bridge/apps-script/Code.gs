const CONFIG = Object.freeze({
  expectedEmail: 'carlosjm.ti23@utsjr.edu.mx',
  timeZone: 'America/Mexico_City',
  folderName: 'ChatGPT Classroom Bridge',
  jsonFileName: 'ChatGPT_Classroom_Pendientes.json',
  markdownFileName: 'ChatGPT_Classroom_Pendientes.md',
  triggerFunction: 'syncClassroom',
  triggerMinutes: 30,
});

const COMPLETED_SUBMISSION_STATES = new Set(['TURNED_IN', 'RETURNED']);

/**
 * Ejecuta esta función una sola vez desde el editor de Apps Script.
 * Autoriza la cuenta escolar, crea los archivos de Drive, sincroniza Classroom
 * e instala una actualización automática cada 30 minutos.
 */
function setup() {
  assertSchoolAccount_();
  removeExistingSyncTriggers_();
  ScriptApp.newTrigger(CONFIG.triggerFunction)
    .timeBased()
    .everyMinutes(CONFIG.triggerMinutes)
    .create();

  const result = syncClassroom();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Sincroniza las tareas pendientes y actualiza los archivos privados de Drive.
 * También puede ejecutarse manualmente cuando se necesite una actualización inmediata.
 */
function syncClassroom() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('Ya hay una sincronización en curso. Intenta de nuevo en un momento.');
  }

  try {
    assertSchoolAccount_();
    const payload = collectPendingTasks_();
    const folder = getOrCreateOutputFolder_();
    const jsonText = JSON.stringify(payload, null, 2) + '\n';
    const markdownText = buildMarkdown_(payload);

    const jsonFileId = upsertTextFile_(
      folder,
      CONFIG.jsonFileName,
      jsonText,
      'application/json'
    );
    const markdownFileId = upsertTextFile_(
      folder,
      CONFIG.markdownFileName,
      markdownText,
      'text/markdown'
    );

    PropertiesService.getScriptProperties().setProperties({
      LAST_SYNC_UTC: payload.generated_at_utc,
      LAST_PENDING_COUNT: String(payload.pending_count),
      LAST_OVERDUE_COUNT: String(payload.overdue_count),
      JSON_FILE_ID: jsonFileId,
      MARKDOWN_FILE_ID: markdownFileId,
    });

    return {
      ok: true,
      pending: payload.pending_count,
      overdue: payload.overdue_count,
      courses: payload.active_course_count,
      generatedAt: payload.generated_at_local,
      folderUrl: folder.getUrl(),
    };
  } finally {
    lock.releaseLock();
  }
}

/** Devuelve el estado de la última sincronización sin volver a consultar Classroom. */
function getStatus() {
  return PropertiesService.getScriptProperties().getProperties();
}

function assertSchoolAccount_() {
  const email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) {
    throw new Error('No fue posible identificar la cuenta de Google que ejecuta el script.');
  }
  if (email !== CONFIG.expectedEmail.toLowerCase()) {
    throw new Error(
      'Cuenta incorrecta. Ejecuta este proyecto con ' + CONFIG.expectedEmail +
      '. Cuenta actual: ' + email
    );
  }
}

function removeExistingSyncTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === CONFIG.triggerFunction) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function collectPendingTasks_() {
  const now = new Date();
  const courses = listAll_(function (pageToken) {
    const options = {
      studentId: 'me',
      courseStates: ['ACTIVE'],
      pageSize: 100,
    };
    if (pageToken) options.pageToken = pageToken;
    return Classroom.Courses.list(options);
  }, 'courses');

  const tasks = [];
  const courseErrors = [];

  courses.forEach(function (course) {
    const courseId = String(course.id);
    const courseName = course.name || 'Curso sin nombre';

    try {
      const courseWork = listAll_(function (pageToken) {
        const options = {
          courseWorkStates: ['PUBLISHED'],
          orderBy: 'dueDate asc,updateTime desc',
          pageSize: 100,
        };
        if (pageToken) options.pageToken = pageToken;
        return Classroom.Courses.CourseWork.list(courseId, options);
      }, 'courseWork');

      const submissions = listAll_(function (pageToken) {
        const options = {
          userId: 'me',
          pageSize: 100,
        };
        if (pageToken) options.pageToken = pageToken;
        return Classroom.Courses.CourseWork.StudentSubmissions.list(
          courseId,
          '-',
          options
        );
      }, 'studentSubmissions');

      const submissionsByWork = {};
      submissions.forEach(function (submission) {
        if (submission.courseWorkId) {
          submissionsByWork[String(submission.courseWorkId)] = submission;
        }
      });

      courseWork.forEach(function (work) {
        const submission = submissionsByWork[String(work.id)] || null;
        const submissionState = submission && submission.state ? submission.state : 'NEW';
        if (COMPLETED_SUBMISSION_STATES.has(submissionState)) return;

        const dueAt = dueDateTimeUtc_(work);
        const status = classifyStatus_(dueAt, now);

        tasks.push({
          course_id: courseId,
          course: courseName,
          coursework_id: String(work.id),
          title: work.title || 'Tarea sin título',
          description: work.description || '',
          type: work.workType || 'ASSIGNMENT',
          submission_state: submissionState,
          late: Boolean(submission && submission.late) || status === 'atrasada',
          status: status,
          due_at_utc: dueAt ? dueAt.toISOString() : null,
          due_at_local: dueAt
            ? Utilities.formatDate(dueAt, CONFIG.timeZone, 'yyyy-MM-dd HH:mm z')
            : null,
          link: work.alternateLink || null,
          max_points: work.maxPoints == null ? null : work.maxPoints,
        });
      });
    } catch (error) {
      courseErrors.push({
        course: courseName,
        error: String(error && error.message ? error.message : error).slice(0, 500),
      });
    }
  });

  const priority = { atrasada: 0, vence_hoy: 1, proxima: 2, sin_fecha: 3 };
  tasks.sort(function (a, b) {
    const priorityA = Object.prototype.hasOwnProperty.call(priority, a.status) ? priority[a.status] : 9;
    const priorityB = Object.prototype.hasOwnProperty.call(priority, b.status) ? priority[b.status] : 9;
    const statusDiff = priorityA - priorityB;
    if (statusDiff !== 0) return statusDiff;

    const dueA = a.due_at_utc || '9999-12-31T23:59:59Z';
    const dueB = b.due_at_utc || '9999-12-31T23:59:59Z';
    if (dueA !== dueB) return dueA.localeCompare(dueB);

    const courseDiff = a.course.toLowerCase().localeCompare(b.course.toLowerCase());
    if (courseDiff !== 0) return courseDiff;
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  });

  return {
    schema_version: 2,
    source: 'Google Apps Script',
    authorized_email: CONFIG.expectedEmail,
    generated_at_utc: now.toISOString(),
    generated_at_local: Utilities.formatDate(now, CONFIG.timeZone, 'yyyy-MM-dd HH:mm:ss z'),
    timezone: CONFIG.timeZone,
    pending_count: tasks.length,
    overdue_count: tasks.filter(function (task) {
      return task.status === 'atrasada';
    }).length,
    active_course_count: courses.length,
    tasks: tasks,
    course_errors: courseErrors,
  };
}

function listAll_(requestPage, itemKey) {
  const items = [];
  let pageToken = null;
  do {
    const response = requestPage(pageToken) || {};
    const pageItems = response[itemKey] || [];
    Array.prototype.push.apply(items, pageItems);
    pageToken = response.nextPageToken || null;
  } while (pageToken);
  return items;
}

function dueDateTimeUtc_(work) {
  if (!work.dueDate) return null;
  const date = work.dueDate;
  const time = work.dueTime || {};
  return new Date(Date.UTC(
    Number(date.year),
    Number(date.month) - 1,
    Number(date.day),
    time.hours == null ? 23 : Number(time.hours),
    time.minutes == null ? 59 : Number(time.minutes),
    time.seconds == null ? 59 : Number(time.seconds)
  ));
}

function classifyStatus_(dueAt, now) {
  if (!dueAt) return 'sin_fecha';
  if (dueAt.getTime() < now.getTime()) return 'atrasada';

  const dueDay = Utilities.formatDate(dueAt, CONFIG.timeZone, 'yyyy-MM-dd');
  const today = Utilities.formatDate(now, CONFIG.timeZone, 'yyyy-MM-dd');
  return dueDay === today ? 'vence_hoy' : 'proxima';
}

function getOrCreateOutputFolder_() {
  const properties = PropertiesService.getScriptProperties();
  const savedId = properties.getProperty('OUTPUT_FOLDER_ID');
  if (savedId) {
    try {
      return DriveApp.getFolderById(savedId);
    } catch (error) {
      properties.deleteProperty('OUTPUT_FOLDER_ID');
    }
  }

  const folders = DriveApp.getFoldersByName(CONFIG.folderName);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(CONFIG.folderName);
  properties.setProperty('OUTPUT_FOLDER_ID', folder.getId());
  return folder;
}

function upsertTextFile_(folder, fileName, content, mimeType) {
  const files = folder.getFilesByName(fileName);
  let file;
  if (files.hasNext()) {
    file = files.next();
    file.setContent(content);
    while (files.hasNext()) {
      files.next().setTrashed(true);
    }
  } else {
    file = folder.createFile(Utilities.newBlob(content, mimeType, fileName));
  }
  return file.getId();
}

function buildMarkdown_(payload) {
  const lines = [
    '# Tareas pendientes de Google Classroom',
    '',
    'Actualizado: **' + payload.generated_at_local + '**',
    'Pendientes: **' + payload.pending_count + '** · Atrasadas: **' + payload.overdue_count + '**',
    '',
  ];

  if (!payload.tasks.length) {
    lines.push('No hay tareas pendientes registradas.', '');
  } else {
    const labels = {
      atrasada: '🔴 Atrasada',
      vence_hoy: '🟠 Vence hoy',
      proxima: '🟢 Próxima',
      sin_fecha: '⚪ Sin fecha',
    };

    payload.tasks.forEach(function (task) {
      lines.push(
        '## ' + singleLine_(task.title),
        '- Materia: **' + singleLine_(task.course) + '**',
        '- Estado: **' + (labels[task.status] || task.status) + '**',
        '- Entrega: `' + (task.due_at_local || 'Sin fecha de entrega') + '`',
        '- Estado en Classroom: `' + task.submission_state + '`'
      );
      if (task.link) lines.push('- Enlace: ' + task.link);
      lines.push('');
    });
  }

  if (payload.course_errors.length) {
    lines.push(
      '---',
      'Algunos cursos no pudieron consultarse. El archivo JSON contiene el diagnóstico.',
      ''
    );
  }

  return lines.join('\n');
}

function singleLine_(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}
