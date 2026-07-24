const AGENT_CONFIG = Object.freeze({
  expectedEmail: 'carlosjm.ti23@utsjr.edu.mx',
  timeZone: 'America/Mexico_City',
  dataFolderName: 'ChatGPT Classroom Bridge',
  deepJsonName: 'ChatGPT_Classroom_Deep_Index.json',
  deepMarkdownName: 'ChatGPT_Classroom_Deep_Index.md',
  snapshotJsonName: 'ChatGPT_Classroom_Last_Page_Snapshot.json',
  commandSpreadsheetName: 'ChatGPT Classroom Agent Commands',
  commandSheetName: 'Commands',
  stateSheetName: 'State',
  syncTriggerMinutes: 30,
  commandTriggerMinutes: 1,
  maxPageTextChars: 60000,
});

const AGENT_COMMAND_HEADERS = [
  'command_id',
  'created_at',
  'action',
  'target_url',
  'course_id',
  'coursework_id',
  'payload_json',
  'requires_confirmation',
  'status',
  'claimed_at',
  'completed_at',
  'result_json',
];

const AGENT_DONE_STATES = new Set(['TURNED_IN', 'RETURNED']);
const AGENT_DESTRUCTIVE_ACTIONS = new Set(['submit', 'attach_and_submit', 'reclaim']);

/**
 * Ejecutar una sola vez después de pegar este archivo y actualizar appsscript.json.
 * Crea el índice profundo, la cola de comandos y los activadores automáticos.
 */
function setupAgentV2() {
  agentAssertSchoolAccount_();
  const folder = agentGetOrCreateFolder_();
  const queue = agentGetOrCreateCommandSpreadsheet_();
  const token = agentGetOrCreateBridgeToken_();

  agentReplaceTrigger_('syncClassroomDeep', AGENT_CONFIG.syncTriggerMinutes);
  agentReplaceTrigger_('processAgentCommands', AGENT_CONFIG.commandTriggerMinutes);

  const syncResult = syncClassroomDeep();
  const result = {
    ok: true,
    folderUrl: folder.getUrl(),
    commandSpreadsheetUrl: queue.getUrl(),
    bridgeToken: token,
    sync: syncResult,
    nextStep: 'Implementar como aplicación web y configurar la extensión con la URL /exec y bridgeToken.',
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Crea un índice completo de cursos, actividades, instrucciones, anexos y estado. */
function syncClassroomDeep() {
  agentAssertSchoolAccount_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Ya hay una sincronización en curso.');

  try {
    const payload = agentCollectDeepIndex_();
    const folder = agentGetOrCreateFolder_();
    agentUpsertTextFile_(folder, AGENT_CONFIG.deepJsonName, JSON.stringify(payload, null, 2) + '\n', 'application/json');
    agentUpsertTextFile_(folder, AGENT_CONFIG.deepMarkdownName, agentBuildDeepMarkdown_(payload), 'text/markdown');
    agentSetState_('LAST_DEEP_SYNC', payload.generated_at_utc);
    agentSetState_('LAST_DEEP_TASK_COUNT', String(payload.coursework_count));
    return {
      ok: true,
      courses: payload.active_course_count,
      coursework: payload.coursework_count,
      pending: payload.pending_count,
      overdue: payload.overdue_count,
      errors: payload.errors.length,
      generatedAt: payload.generated_at_local,
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Procesa solo comandos seguros del lado servidor. Las acciones DOM quedan en estado queued
 * para que la extensión de Chrome las reclame y ejecute en classroom.google.com.
 */
function processAgentCommands() {
  agentAssertSchoolAccount_();
  const sheet = agentGetCommandSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { ok: true, processed: 0 };

  const index = agentHeaderIndex_(values[0]);
  let processed = 0;
  for (let row = 1; row < values.length; row += 1) {
    const status = String(values[row][index.status] || '').trim().toLowerCase();
    const action = String(values[row][index.action] || '').trim().toLowerCase();
    if (status !== 'queued') continue;

    if (action === 'sync_deep') {
      try {
        const result = syncClassroomDeep();
        agentCompleteCommandRow_(sheet, row + 1, index, 'completed', result);
      } catch (error) {
        agentCompleteCommandRow_(sheet, row + 1, index, 'failed', { error: agentErrorText_(error) });
      }
      processed += 1;
    }
  }
  return { ok: true, processed: processed };
}

/** Endpoint de la extensión. Implementar como aplicación web que ejecuta como el propietario. */
function doGet(e) {
  try {
    agentAuthorizeRequest_(e);
    const action = String((e && e.parameter && e.parameter.action) || 'health').toLowerCase();
    if (action === 'health') return agentJsonResponse_({ ok: true, service: 'classroom-agent-v2' });
    if (action === 'next') return agentJsonResponse_(agentNextBrowserCommand_());
    if (action === 'bootstrap') {
      return agentJsonResponse_({
        ok: true,
        commandSpreadsheetUrl: agentGetOrCreateCommandSpreadsheet_().getUrl(),
        folderUrl: agentGetOrCreateFolder_().getUrl(),
      });
    }
    return agentJsonResponse_({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return agentJsonResponse_({ ok: false, error: agentErrorText_(error) });
  }
}

function doPost(e) {
  try {
    agentAuthorizeRequest_(e);
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(body.action || '').toLowerCase();

    if (action === 'claim') return agentJsonResponse_(agentClaimCommand_(body.commandId));
    if (action === 'result') return agentJsonResponse_(agentRecordBrowserResult_(body));
    if (action === 'snapshot') return agentJsonResponse_(agentSavePageSnapshot_(body));
    return agentJsonResponse_({ ok: false, error: 'Unknown POST action' });
  } catch (error) {
    return agentJsonResponse_({ ok: false, error: agentErrorText_(error) });
  }
}

function agentCollectDeepIndex_() {
  const now = new Date();
  const errors = [];
  const courses = agentListAll_(function (pageToken) {
    const options = { studentId: 'me', courseStates: ['ACTIVE'], pageSize: 100 };
    if (pageToken) options.pageToken = pageToken;
    return Classroom.Courses.list(options);
  }, 'courses');

  const courseRecords = [];
  let courseworkCount = 0;
  let pendingCount = 0;
  let overdueCount = 0;

  courses.forEach(function (course) {
    const courseId = String(course.id);
    const courseName = course.name || 'Curso sin nombre';
    const record = {
      id: courseId,
      name: courseName,
      section: course.section || '',
      alternate_link: course.alternateLink || '',
      topics: [],
      announcements: [],
      coursework: [],
      errors: [],
    };

    try {
      const topics = agentListAll_(function (pageToken) {
        const options = { pageSize: 100 };
        if (pageToken) options.pageToken = pageToken;
        return Classroom.Courses.Topics.list(courseId, options);
      }, 'topic');
      record.topics = topics.map(function (topic) {
        return { id: String(topic.topicId || ''), name: topic.name || '' };
      });
    } catch (error) {
      record.errors.push({ area: 'topics', error: agentErrorText_(error) });
    }

    const topicNames = {};
    record.topics.forEach(function (topic) { topicNames[topic.id] = topic.name; });

    try {
      const announcements = agentListAll_(function (pageToken) {
        const options = { announcementStates: ['PUBLISHED'], orderBy: 'updateTime desc', pageSize: 100 };
        if (pageToken) options.pageToken = pageToken;
        return Classroom.Courses.Announcements.list(courseId, options);
      }, 'announcements');
      record.announcements = announcements.map(function (announcement) {
        return {
          id: String(announcement.id || ''),
          text: announcement.text || '',
          alternate_link: announcement.alternateLink || '',
          materials: agentExtractMaterials_(announcement.materials || []),
          creation_time: announcement.creationTime || null,
          update_time: announcement.updateTime || null,
        };
      });
    } catch (error) {
      record.errors.push({ area: 'announcements', error: agentErrorText_(error) });
    }

    try {
      const workItems = agentListAll_(function (pageToken) {
        const options = { courseWorkStates: ['PUBLISHED'], orderBy: 'dueDate asc,updateTime desc', pageSize: 100 };
        if (pageToken) options.pageToken = pageToken;
        return Classroom.Courses.CourseWork.list(courseId, options);
      }, 'courseWork');

      const submissions = agentListAll_(function (pageToken) {
        const options = { userId: 'me', pageSize: 100 };
        if (pageToken) options.pageToken = pageToken;
        return Classroom.Courses.CourseWork.StudentSubmissions.list(courseId, '-', options);
      }, 'studentSubmissions');
      const submissionsByWork = {};
      submissions.forEach(function (submission) {
        if (submission.courseWorkId) submissionsByWork[String(submission.courseWorkId)] = submission;
      });

      record.coursework = workItems.map(function (work) {
        const workId = String(work.id || '');
        const submission = submissionsByWork[workId] || null;
        const submissionState = submission && submission.state ? submission.state : 'NEW';
        const dueAt = agentDueDateTimeUtc_(work);
        const status = AGENT_DONE_STATES.has(submissionState) ? 'completada' : agentClassifyStatus_(dueAt, now);
        courseworkCount += 1;
        if (status !== 'completada') pendingCount += 1;
        if (status === 'atrasada') overdueCount += 1;

        let rubric = null;
        try {
          const response = Classroom.Courses.CourseWork.Rubrics.list(courseId, workId, { pageSize: 100 });
          rubric = response.rubrics || [];
        } catch (error) {
          // Rubrics are optional and may not be enabled for every course.
        }

        return {
          id: workId,
          course_id: courseId,
          course_name: courseName,
          title: work.title || 'Actividad sin título',
          description: work.description || '',
          work_type: work.workType || 'ASSIGNMENT',
          topic_id: work.topicId ? String(work.topicId) : null,
          topic_name: work.topicId ? (topicNames[String(work.topicId)] || '') : '',
          alternate_link: work.alternateLink || '',
          materials: agentExtractMaterials_(work.materials || []),
          rubric: rubric,
          max_points: work.maxPoints == null ? null : work.maxPoints,
          due_at_utc: dueAt ? dueAt.toISOString() : null,
          due_at_local: dueAt ? Utilities.formatDate(dueAt, AGENT_CONFIG.timeZone, 'yyyy-MM-dd HH:mm z') : null,
          status: status,
          submission: agentNormalizeSubmission_(submission),
          creation_time: work.creationTime || null,
          update_time: work.updateTime || null,
        };
      });
    } catch (error) {
      const detail = { area: 'coursework', error: agentErrorText_(error) };
      record.errors.push(detail);
      errors.push({ course: courseName, course_id: courseId, detail: detail });
    }

    courseRecords.push(record);
  });

  return {
    schema_version: 3,
    source: 'Google Apps Script Classroom Agent V2',
    authorized_email: AGENT_CONFIG.expectedEmail,
    generated_at_utc: now.toISOString(),
    generated_at_local: Utilities.formatDate(now, AGENT_CONFIG.timeZone, 'yyyy-MM-dd HH:mm:ss z'),
    timezone: AGENT_CONFIG.timeZone,
    active_course_count: courses.length,
    coursework_count: courseworkCount,
    pending_count: pendingCount,
    overdue_count: overdueCount,
    courses: courseRecords,
    errors: errors,
  };
}

function agentExtractMaterials_(materials) {
  return materials.map(function (material) {
    if (material.driveFile && material.driveFile.driveFile) {
      const file = material.driveFile.driveFile;
      return { type: 'drive_file', id: file.id || '', title: file.title || '', url: file.alternateLink || '', thumbnail_url: file.thumbnailUrl || '' };
    }
    if (material.link) return { type: 'link', title: material.link.title || '', url: material.link.url || '', thumbnail_url: material.link.thumbnailUrl || '' };
    if (material.youtubeVideo) return { type: 'youtube', id: material.youtubeVideo.id || '', title: material.youtubeVideo.title || '', url: material.youtubeVideo.alternateLink || '', thumbnail_url: material.youtubeVideo.thumbnailUrl || '' };
    if (material.form) return { type: 'form', title: material.form.title || '', url: material.form.formUrl || '', response_url: material.form.responseUrl || '', thumbnail_url: material.form.thumbnailUrl || '' };
    return { type: 'unknown', raw: material };
  });
}

function agentNormalizeSubmission_(submission) {
  if (!submission) return { state: 'NEW', late: false, assigned_grade: null, draft_grade: null, attachments: [] };
  return {
    id: String(submission.id || ''),
    state: submission.state || 'NEW',
    late: Boolean(submission.late),
    assigned_grade: submission.assignedGrade == null ? null : submission.assignedGrade,
    draft_grade: submission.draftGrade == null ? null : submission.draftGrade,
    alternate_link: submission.alternateLink || '',
    attachments: agentExtractMaterials_(submission.assignmentSubmission && submission.assignmentSubmission.attachments || []),
    submission_history: submission.submissionHistory || [],
  };
}

function agentNextBrowserCommand_() {
  const sheet = agentGetCommandSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { ok: true, command: null };
  const index = agentHeaderIndex_(values[0]);

  for (let row = 1; row < values.length; row += 1) {
    const status = String(values[row][index.status] || '').trim().toLowerCase();
    const action = String(values[row][index.action] || '').trim().toLowerCase();
    if (status !== 'queued' || action === 'sync_deep') continue;
    const payloadText = String(values[row][index.payload_json] || '{}');
    let payload = {};
    try { payload = JSON.parse(payloadText); } catch (error) { payload = { raw: payloadText }; }
    return {
      ok: true,
      command: {
        commandId: String(values[row][index.command_id] || ''),
        action: action,
        targetUrl: String(values[row][index.target_url] || ''),
        courseId: String(values[row][index.course_id] || ''),
        courseworkId: String(values[row][index.coursework_id] || ''),
        payload: payload,
        requiresConfirmation: agentBoolean_(values[row][index.requires_confirmation]) || AGENT_DESTRUCTIVE_ACTIONS.has(action),
      },
    };
  }
  return { ok: true, command: null };
}

function agentClaimCommand_(commandId) {
  return agentMutateCommand_(commandId, function (sheet, row, index) {
    const status = String(sheet.getRange(row, index.status + 1).getValue() || '').toLowerCase();
    if (status !== 'queued') return { ok: false, error: 'Command is not queued', status: status };
    sheet.getRange(row, index.status + 1).setValue('claimed');
    sheet.getRange(row, index.claimed_at + 1).setValue(new Date());
    return { ok: true };
  });
}

function agentRecordBrowserResult_(body) {
  return agentMutateCommand_(body.commandId, function (sheet, row, index) {
    const status = body.ok ? 'completed' : (body.status || 'failed');
    sheet.getRange(row, index.status + 1).setValue(status);
    sheet.getRange(row, index.completed_at + 1).setValue(new Date());
    sheet.getRange(row, index.result_json + 1).setValue(JSON.stringify(body.result || { error: body.error || '' }));
    return { ok: true, status: status };
  });
}

function agentSavePageSnapshot_(body) {
  const snapshot = {
    captured_at_utc: new Date().toISOString(),
    url: String(body.url || ''),
    title: String(body.title || ''),
    text: String(body.text || '').slice(0, AGENT_CONFIG.maxPageTextChars),
    links: Array.isArray(body.links) ? body.links.slice(0, 300) : [],
    buttons: Array.isArray(body.buttons) ? body.buttons.slice(0, 150) : [],
    command_id: String(body.commandId || ''),
  };
  const folder = agentGetOrCreateFolder_();
  agentUpsertTextFile_(folder, AGENT_CONFIG.snapshotJsonName, JSON.stringify(snapshot, null, 2) + '\n', 'application/json');
  return { ok: true, saved: true };
}

function agentGetOrCreateCommandSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty('AGENT_COMMAND_SPREADSHEET_ID');
  let spreadsheet = null;
  if (existingId) {
    try { spreadsheet = SpreadsheetApp.openById(existingId); } catch (error) { spreadsheet = null; }
  }
  if (!spreadsheet) {
    const files = DriveApp.getFilesByName(AGENT_CONFIG.commandSpreadsheetName);
    if (files.hasNext()) spreadsheet = SpreadsheetApp.open(files.next());
  }
  if (!spreadsheet) spreadsheet = SpreadsheetApp.create(AGENT_CONFIG.commandSpreadsheetName);
  props.setProperty('AGENT_COMMAND_SPREADSHEET_ID', spreadsheet.getId());
  agentInitializeSpreadsheet_(spreadsheet);
  return spreadsheet;
}

function agentInitializeSpreadsheet_(spreadsheet) {
  let commands = spreadsheet.getSheetByName(AGENT_CONFIG.commandSheetName);
  if (!commands) commands = spreadsheet.insertSheet(AGENT_CONFIG.commandSheetName);
  if (commands.getLastRow() === 0) commands.appendRow(AGENT_COMMAND_HEADERS);
  else commands.getRange(1, 1, 1, AGENT_COMMAND_HEADERS.length).setValues([AGENT_COMMAND_HEADERS]);
  commands.setFrozenRows(1);

  let state = spreadsheet.getSheetByName(AGENT_CONFIG.stateSheetName);
  if (!state) state = spreadsheet.insertSheet(AGENT_CONFIG.stateSheetName);
  if (state.getLastRow() === 0) state.appendRow(['key', 'value', 'updated_at']);

  const first = spreadsheet.getSheets()[0];
  if (first.getName() === 'Sheet1' || first.getName() === 'Hoja 1') spreadsheet.deleteSheet(first);
}

function agentGetCommandSheet_() {
  return agentGetOrCreateCommandSpreadsheet_().getSheetByName(AGENT_CONFIG.commandSheetName);
}

function agentSetState_(key, value) {
  const sheet = agentGetOrCreateCommandSpreadsheet_().getSheetByName(AGENT_CONFIG.stateSheetName);
  const values = sheet.getDataRange().getValues();
  for (let row = 1; row < values.length; row += 1) {
    if (String(values[row][0]) === key) {
      sheet.getRange(row + 1, 2, 1, 2).setValues([[value, new Date()]]);
      return;
    }
  }
  sheet.appendRow([key, value, new Date()]);
}

function agentMutateCommand_(commandId, callback) {
  const sheet = agentGetCommandSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: 'Command not found' };
  const index = agentHeaderIndex_(values[0]);
  for (let row = 1; row < values.length; row += 1) {
    if (String(values[row][index.command_id]) === String(commandId)) return callback(sheet, row + 1, index);
  }
  return { ok: false, error: 'Command not found' };
}

function agentCompleteCommandRow_(sheet, row, index, status, result) {
  sheet.getRange(row, index.status + 1).setValue(status);
  sheet.getRange(row, index.completed_at + 1).setValue(new Date());
  sheet.getRange(row, index.result_json + 1).setValue(JSON.stringify(result));
}

function agentHeaderIndex_(headers) {
  const index = {};
  headers.forEach(function (header, position) { index[String(header)] = position; });
  AGENT_COMMAND_HEADERS.forEach(function (header) {
    if (!Object.prototype.hasOwnProperty.call(index, header)) throw new Error('Falta la columna ' + header);
  });
  return index;
}

function agentGetOrCreateBridgeToken_() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('AGENT_BRIDGE_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('AGENT_BRIDGE_TOKEN', token);
  }
  return token;
}

function agentAuthorizeRequest_(e) {
  const supplied = String((e && e.parameter && e.parameter.token) || '').trim();
  const expected = agentGetOrCreateBridgeToken_();
  if (!supplied || supplied !== expected) throw new Error('Unauthorized');
}

function agentReplaceTrigger_(handler, minutes) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(minutes).create();
}

function agentGetOrCreateFolder_() {
  const folders = DriveApp.getFoldersByName(AGENT_CONFIG.dataFolderName);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(AGENT_CONFIG.dataFolderName);
}

function agentUpsertTextFile_(folder, name, content, mimeType) {
  const files = folder.getFilesByName(name);
  if (files.hasNext()) {
    const file = files.next();
    file.setContent(content);
    return file.getId();
  }
  return folder.createFile(name, content, mimeType).getId();
}

function agentBuildDeepMarkdown_(payload) {
  const lines = [
    '# Índice profundo de Google Classroom',
    '',
    '- Actualizado: **' + payload.generated_at_local + '**',
    '- Cursos activos: **' + payload.active_course_count + '**',
    '- Actividades: **' + payload.coursework_count + '**',
    '- Pendientes: **' + payload.pending_count + '**',
    '- Atrasadas: **' + payload.overdue_count + '**',
    '',
  ];
  payload.courses.forEach(function (course) {
    lines.push('## ' + agentSingleLine_(course.name), '');
    course.coursework.forEach(function (work) {
      lines.push('### ' + agentSingleLine_(work.title));
      lines.push('- Estado: **' + work.status + '**');
      lines.push('- Entrega: ' + (work.due_at_local || 'Sin fecha'));
      lines.push('- Classroom: ' + (work.alternate_link || 'Sin enlace'));
      if (work.description) lines.push('', work.description, '');
      if (work.materials.length) {
        lines.push('- Anexos:');
        work.materials.forEach(function (material) {
          lines.push('  - [' + (material.title || material.type) + '](' + (material.url || material.response_url || '#') + ')');
        });
      }
      lines.push('');
    });
  });
  return lines.join('\n');
}

function agentListAll_(requestPage, itemKey) {
  const items = [];
  let pageToken = null;
  do {
    const response = requestPage(pageToken) || {};
    Array.prototype.push.apply(items, response[itemKey] || []);
    pageToken = response.nextPageToken || null;
  } while (pageToken);
  return items;
}

function agentDueDateTimeUtc_(work) {
  if (!work.dueDate) return null;
  const date = work.dueDate;
  const time = work.dueTime || {};
  const local = new Date(Number(date.year), Number(date.month) - 1, Number(date.day), Number(time.hours || 23), Number(time.minutes || 59), Number(time.seconds || 0));
  return new Date(local.getTime());
}

function agentClassifyStatus_(dueAt, now) {
  if (!dueAt) return 'sin_fecha';
  if (dueAt.getTime() < now.getTime()) return 'atrasada';
  const today = Utilities.formatDate(now, AGENT_CONFIG.timeZone, 'yyyy-MM-dd');
  const dueDay = Utilities.formatDate(dueAt, AGENT_CONFIG.timeZone, 'yyyy-MM-dd');
  return dueDay === today ? 'vence_hoy' : 'proxima';
}

function agentAssertSchoolAccount_() {
  const email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (email !== AGENT_CONFIG.expectedEmail.toLowerCase()) throw new Error('Cuenta incorrecta: ' + email);
}

function agentJsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function agentBoolean_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function agentSingleLine_(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function agentErrorText_(error) {
  return String(error && error.message ? error.message : error).slice(0, 1000);
}
