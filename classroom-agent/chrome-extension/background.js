const POLL_ALARM = 'chatgpt-classroom-agent-poll';
const JOB_TIMEOUT_PREFIX = 'chatgpt-classroom-agent-timeout:';
const POLL_MINUTES = 1;
const JOB_TIMEOUT_MINUTES = 3;
const CLASSROOM_READY_TIMEOUT_MS = 65000;
const ACTIVE_JOBS_KEY = 'classroomActiveJobs';
let pollInFlight = false;

chrome.runtime.onInstalled.addListener(() => {
  void initializeBackgroundAgent();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeBackgroundAgent();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    void pollAuthorizedCommands();
    return;
  }
  if (alarm.name.startsWith(JOB_TIMEOUT_PREFIX)) {
    const commandId = alarm.name.slice(JOB_TIMEOUT_PREFIX.length);
    void failTimedOutJob(commandId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'run-background-poll') {
    sendResponse({ ok: true, started: true });
    void pollAuthorizedCommands();
    return false;
  }

  if (message?.type === 'execute-approved-command') {
    sendResponse({ ok: true, started: true });
    void launchManualCommand(message.command).catch((error) => {
      void setBadge('×', '#b91c1c', error.message || String(error));
    });
    return false;
  }

  if (message?.type === 'classroom-command-finished') {
    sendResponse({ ok: true, accepted: true });
    void finishDetachedCommand(message.commandId, message.result, sender.tab?.id);
    return false;
  }

  return false;
});

void initializeBackgroundAgent();

async function initializeBackgroundAgent() {
  await chrome.alarms.create(POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: POLL_MINUTES,
  });
  await recoverActiveJobs();
  await pollAuthorizedCommands();
}

async function pollAuthorizedCommands() {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const config = await getConfig();
    if (!config) {
      await setBadge('?', '#6b7280', 'Falta configurar la conexión del agente.');
      return;
    }

    const jobs = await getActiveJobs();
    if (Object.keys(jobs).length > 0) {
      await setBadge('…', '#2563eb', 'Hay una acción automática en ejecución.');
      return;
    }

    const data = await getApi(config, { action: 'next' });
    if (!data.ok) throw new Error(data.error || 'El servidor devolvió un error.');
    if (!data.command) {
      await clearBadge();
      return;
    }

    const command = data.command;
    if (!isAutoAuthorized(command)) {
      await setBadge('!', '#c0841a', 'Hay una acción pendiente de aprobación manual.');
      return;
    }

    const claim = await postApi(config, {
      action: 'claim',
      commandId: command.commandId,
    });
    if (!claim.ok) {
      if (claim.status === 'claimed' || claim.status === 'completed') return;
      throw new Error(claim.error || 'No se pudo reclamar la acción automática.');
    }

    await launchDetachedCommand(command, { backgroundTab: true });
    await setBadge('…', '#2563eb', 'Acción automática en ejecución.');
  } catch (error) {
    await setBadge('×', '#b91c1c', error.message || String(error));
  } finally {
    pollInFlight = false;
  }
}

function isAutoAuthorized(command) {
  const payload = command?.payload || {};
  return payload.autoAuthorized === true || payload.auto_authorized === true;
}

async function launchManualCommand(command) {
  await launchDetachedCommand(command, { backgroundTab: false });
}

async function launchDetachedCommand(command, options = {}) {
  const targetUrl = command?.targetUrl
    || command?.payload?.targetUrl
    || command?.payload?.alternateLink
    || 'https://classroom.google.com/';

  const backgroundTab = Boolean(options.backgroundTab);
  let tab;

  if (backgroundTab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: false });
  } else {
    const tabs = await chrome.tabs.query({ url: 'https://classroom.google.com/*' });
    tab = tabs.find((item) => item.active) || tabs[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url: targetUrl, active: true });
    } else {
      tab = await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    }
  }

  try {
    await waitForTab(tab.id, 35000);
    await ensureClassroomReady(tab.id, targetUrl, CLASSROOM_READY_TIMEOUT_MS);
    await ensureContentScript(tab.id);

    await saveActiveJob(command.commandId, {
      command,
      tabId: tab.id,
      backgroundTab,
      startedAt: Date.now(),
    });

    await chrome.alarms.create(`${JOB_TIMEOUT_PREFIX}${command.commandId}`, {
      delayInMinutes: JOB_TIMEOUT_MINUTES,
    });

    const acknowledgement = await chrome.tabs.sendMessage(tab.id, {
      type: 'execute-classroom-command-detached',
      command,
    });

    if (!acknowledgement?.accepted) {
      throw new Error('El script de Classroom no aceptó la acción automática.');
    }
  } catch (error) {
    await removeActiveJob(command.commandId);
    await chrome.alarms.clear(`${JOB_TIMEOUT_PREFIX}${command.commandId}`);
    if (backgroundTab && tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch (closeError) {}
    }
    await reportCommandResult(command.commandId, {
      ok: false,
      error: error.message || String(error),
    });
    throw error;
  }
}

async function finishDetachedCommand(commandId, result, senderTabId) {
  const jobs = await getActiveJobs();
  const job = jobs[commandId] || null;
  const normalizedResult = result && typeof result === 'object'
    ? result
    : { ok: false, error: 'El script de Classroom devolvió un resultado inválido.' };

  try {
    await reportCommandResult(commandId, normalizedResult);
    if (normalizedResult.ok) {
      await setBadge('✓', '#2f855a', 'Última acción automática completada.');
    } else {
      await setBadge('×', '#b91c1c', normalizedResult.error || 'La acción automática falló.');
    }
  } finally {
    await chrome.alarms.clear(`${JOB_TIMEOUT_PREFIX}${commandId}`);
    await removeActiveJob(commandId);

    const tabId = job?.tabId || senderTabId;
    if (job?.backgroundTab && tabId) {
      try { await chrome.tabs.remove(tabId); } catch (error) {}
    }

    setTimeout(() => {
      void pollAuthorizedCommands();
    }, 500);
  }
}

async function failTimedOutJob(commandId) {
  const jobs = await getActiveJobs();
  const job = jobs[commandId];
  if (!job) return;

  const snapshot = job.tabId ? await captureClassroomPageSafe(job.tabId) : null;
  const result = {
    ok: false,
    error: 'La acción automática excedió el tiempo máximo y no confirmó el resultado.',
    snapshot,
  };

  try {
    await reportCommandResult(commandId, result);
    await setBadge('×', '#b91c1c', result.error);
  } finally {
    await removeActiveJob(commandId);
    if (job.backgroundTab && job.tabId) {
      try { await chrome.tabs.remove(job.tabId); } catch (error) {}
    }
    void pollAuthorizedCommands();
  }
}

async function recoverActiveJobs() {
  const jobs = await getActiveJobs();
  const now = Date.now();

  for (const [commandId, job] of Object.entries(jobs)) {
    const ageMs = now - Number(job.startedAt || 0);
    if (ageMs > JOB_TIMEOUT_MINUTES * 60 * 1000) {
      await failTimedOutJob(commandId);
      continue;
    }

    try {
      if (job.tabId) await chrome.tabs.get(job.tabId);
      await chrome.alarms.create(`${JOB_TIMEOUT_PREFIX}${commandId}`, {
        delayInMinutes: Math.max(0.5, JOB_TIMEOUT_MINUTES - ageMs / 60000),
      });
    } catch (error) {
      await finishDetachedCommand(commandId, {
        ok: false,
        error: 'La pestaña de Classroom se cerró antes de terminar la acción.',
      });
    }
  }
}

async function reportCommandResult(commandId, result) {
  const config = await getConfig();
  if (!config) throw new Error('Falta configurar la conexión del agente.');

  if (result?.snapshot) {
    await postApi(config, {
      action: 'snapshot',
      commandId,
      ...result.snapshot,
    });
  }

  const report = await postApi(config, {
    action: 'result',
    commandId,
    ok: Boolean(result?.ok),
    status: result?.ok ? 'completed' : 'failed',
    result: result || {},
    error: result?.error || '',
  });

  if (!report.ok) {
    throw new Error(report.error || 'No se pudo registrar el resultado automático.');
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'classroom-agent-ping' });
    if (response?.ok) return;
  } catch (error) {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  await sleep(500);
}

async function ensureClassroomReady(tabId, targetUrl, timeoutMs) {
  const started = Date.now();
  let reloaded = false;

  while (Date.now() - started < timeoutMs) {
    const state = await inspectClassroomTab(tabId);
    if (state.loginRequired) {
      throw new Error('Classroom solicitó iniciar sesión en la cuenta escolar.');
    }
    if (state.ready) return state;

    if (!reloaded && Date.now() - started > 22000) {
      await chrome.tabs.reload(tabId);
      await waitForTab(tabId, 35000);
      reloaded = true;
    }

    await sleep(1500);
  }

  const last = await inspectClassroomTab(tabId);
  throw new Error(
    `Classroom abrió la actividad, pero no terminó de mostrar el panel de trabajo. URL actual: ${last.url || targetUrl}`,
  );
}

async function inspectClassroomTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const normalized = bodyText.toLocaleLowerCase('es-MX');
        const title = String(document.title || '');
        const markers = [
          'tu trabajo',
          'your work',
          'agregar o crear',
          'añadir o crear',
          'add or create',
          'marcar como completada',
          'mark as done',
          'entregar',
          'turn in',
          'anular la entrega',
          'unsubmit',
        ];
        return {
          ready: /\/a\//.test(location.pathname) && markers.some((marker) => normalized.includes(marker)),
          loginRequired: /iniciar sesión|sign in/i.test(title + ' ' + bodyText),
          url: location.href,
          title,
        };
      },
    });
    return results?.[0]?.result || { ready: false, loginRequired: false, url: '' };
  } catch (error) {
    return { ready: false, loginRequired: false, url: '', error: error.message || String(error) };
  }
}

async function captureClassroomPageSafe(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        title: document.title,
        text: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60000),
        links: Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map((anchor) => ({
          text: String(anchor.innerText || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          url: anchor.href,
        })),
        buttons: Array.from(document.querySelectorAll('button,[role="button"]')).slice(0, 150).map((button) =>
          String(button.innerText || button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        ).filter(Boolean),
      }),
    });
    return results?.[0]?.result || null;
  } catch (error) {
    return null;
  }
}

function waitForTab(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => finish(new Error('Classroom tardó demasiado en cargar.')), timeoutMs);

    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error); else resolve();
    }

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((current) => {
      if (current.status === 'complete') finish();
    }).catch(finish);
  });
}

async function getActiveJobs() {
  const stored = await chrome.storage.local.get({ [ACTIVE_JOBS_KEY]: {} });
  return stored[ACTIVE_JOBS_KEY] || {};
}

async function saveActiveJob(commandId, job) {
  const jobs = await getActiveJobs();
  jobs[commandId] = job;
  await chrome.storage.local.set({ [ACTIVE_JOBS_KEY]: jobs });
}

async function removeActiveJob(commandId) {
  const jobs = await getActiveJobs();
  delete jobs[commandId];
  await chrome.storage.local.set({ [ACTIVE_JOBS_KEY]: jobs });
}

async function getConfig() {
  const config = await chrome.storage.local.get({ endpoint: '', token: '' });
  if (!config.endpoint || !config.token) return null;
  return config;
}

async function getApi(config, params) {
  const response = await fetch(apiUrl(config, params), {
    method: 'GET',
    redirect: 'follow',
    cache: 'no-store',
    credentials: 'omit',
  });
  return parseJsonResponse(response);
}

async function postApi(config, body) {
  const response = await fetch(apiUrl(config), {
    method: 'POST',
    redirect: 'follow',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJsonResponse(response);
}

async function parseJsonResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const preview = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`Apps Script devolvió HTML en lugar de JSON (${response.status}): ${preview}`);
  }
  return response.json();
}

function apiUrl(config, params = {}) {
  const url = new URL(config.endpoint);
  url.searchParams.set('token', config.token);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title: `ChatGPT Classroom Agent - ${title}` });
}

async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'ChatGPT Classroom Agent' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
