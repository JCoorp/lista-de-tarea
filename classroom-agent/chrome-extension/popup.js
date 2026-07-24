let currentCommand = null;

const elements = {
  status: document.getElementById('status'),
  card: document.getElementById('commandCard'),
  action: document.getElementById('action'),
  course: document.getElementById('course'),
  coursework: document.getElementById('coursework'),
  target: document.getElementById('target'),
  payload: document.getElementById('payload'),
  warning: document.getElementById('warning'),
  approve: document.getElementById('approve'),
  reject: document.getElementById('reject'),
  refresh: document.getElementById('refresh'),
};

elements.refresh.addEventListener('click', loadNextCommand);
elements.approve.addEventListener('click', approveCommand);
elements.reject.addEventListener('click', rejectCommand);
document.addEventListener('DOMContentLoaded', loadNextCommand);

async function loadNextCommand() {
  setBusy(true, 'Consultando la cola…');
  currentCommand = null;
  elements.card.hidden = true;
  try {
    const config = await getConfig();
    const data = await getApi(config, { action: 'next' });
    if (!data.ok) throw new Error(data.error || 'El servidor devolvió un error.');
    if (!data.command) {
      elements.status.textContent = 'No hay acciones pendientes.';
      return;
    }
    currentCommand = data.command;
    renderCommand(data.command);
    elements.status.textContent = data.command.requiresConfirmation
      ? 'Revisa los datos antes de ejecutar.'
      : 'Acción lista para ejecutarse.';
  } catch (error) {
    elements.status.textContent = error.message || String(error);
  } finally {
    setBusy(false);
  }
}

async function approveCommand() {
  if (!currentCommand) return;
  setBusy(true, 'Ejecutando en Classroom…');
  try {
    const config = await getConfig();
    const claim = await postApi(config, {
      action: 'claim',
      commandId: currentCommand.commandId,
    });
    if (!claim.ok) throw new Error(claim.error || 'No se pudo reclamar la acción.');

    const result = await chrome.runtime.sendMessage({
      type: 'execute-approved-command',
      command: currentCommand,
    });

    if (result?.snapshot) {
      await postApi(config, {
        action: 'snapshot',
        commandId: currentCommand.commandId,
        ...result.snapshot,
      });
    }

    const report = await postApi(config, {
      action: 'result',
      commandId: currentCommand.commandId,
      ok: Boolean(result?.ok),
      status: result?.ok ? 'completed' : 'failed',
      result: result || {},
      error: result?.error || '',
    });
    if (!report.ok) throw new Error(report.error || 'No se pudo registrar el resultado.');

    elements.status.textContent = result?.ok
      ? 'Acción completada y registrada.'
      : `La acción falló: ${result?.error || 'error desconocido'}`;
    elements.card.hidden = true;
    currentCommand = null;
  } catch (error) {
    elements.status.textContent = error.message || String(error);
  } finally {
    setBusy(false);
  }
}

async function rejectCommand() {
  if (!currentCommand) return;
  setBusy(true, 'Rechazando acción…');
  try {
    const config = await getConfig();
    const response = await postApi(config, {
      action: 'result',
      commandId: currentCommand.commandId,
      ok: false,
      status: 'rejected',
      result: { reason: 'Rechazado por el usuario desde la extensión.' },
    });
    if (!response.ok) throw new Error(response.error || 'No se pudo rechazar la acción.');
    elements.status.textContent = 'Acción rechazada.';
    elements.card.hidden = true;
    currentCommand = null;
  } catch (error) {
    elements.status.textContent = error.message || String(error);
  } finally {
    setBusy(false);
  }
}

function renderCommand(command) {
  elements.action.textContent = command.action || '—';
  elements.course.textContent = command.payload?.courseName || command.courseId || '—';
  elements.coursework.textContent = command.payload?.courseworkTitle || command.courseworkId || '—';
  elements.target.textContent = command.targetUrl || '—';
  elements.payload.textContent = summarizePayload(command.payload || {});

  const destructive = ['submit', 'attach_and_submit', 'reclaim'].includes(command.action);
  elements.warning.hidden = !destructive;
  elements.warning.textContent = destructive
    ? 'Esta acción cambia el estado de una entrega. Verifica el curso, la actividad y el enlace antes de aprobar.'
    : '';
  elements.card.hidden = false;
}

function summarizePayload(payload) {
  const parts = [];
  if (payload.url || payload.attachmentUrl) parts.push(`Enlace: ${payload.url || payload.attachmentUrl}`);
  if (payload.note) parts.push(`Nota: ${payload.note}`);
  if (payload.repository) parts.push(`Repositorio: ${payload.repository}`);
  return parts.length ? parts.join('\n') : JSON.stringify(payload, null, 2);
}

async function getConfig() {
  const config = await chrome.storage.local.get({ endpoint: '', token: '' });
  if (!config.endpoint || !config.token) {
    throw new Error('Abre Configuración y agrega la URL de la aplicación web y el token privado.');
  }
  return config;
}

async function getApi(config, params) {
  const response = await fetch(apiUrl(config, params), {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
  });
  return response.json();
}

async function postApi(config, body) {
  const response = await fetch(apiUrl(config), {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

function apiUrl(config, params = {}) {
  const url = new URL(config.endpoint);
  url.searchParams.set('token', config.token);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function setBusy(busy, message) {
  elements.approve.disabled = busy;
  elements.reject.disabled = busy;
  elements.refresh.disabled = busy;
  if (message) elements.status.textContent = message;
}
