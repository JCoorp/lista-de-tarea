const POLL_ALARM = 'chatgpt-classroom-agent-poll';
const POLL_MINUTES = 1;
const MAX_COMMANDS_PER_CYCLE = 3;
const CLASSROOM_READY_TIMEOUT_MS = 65000;
const COMMAND_OUTCOME_TIMEOUT_MS = 90000;
let pollInFlight = false;

chrome.runtime.onInstalled.addListener(() => {
  void initializeBackgroundAgent();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeBackgroundAgent();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void pollAuthorizedCommands();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'execute-approved-command') {
    executeApprovedCommand(message.command, { backgroundTab: false })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === 'run-background-poll') {
    sendResponse({ ok: true, started: true });
    void pollAuthorizedCommands();
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

    for (let index = 0; index < MAX_COMMANDS_PER_CYCLE; index += 1) {
      const data = await getApi(config, { action: 'next' });
      if (!data.ok) throw new Error(data.error || 'El servidor devolvió un error.');
      if (!data.command) {
        await clearBadge();
        break;
      }

      const command = data.command;
      if (!isAutoAuthorized(command)) {
        await setBadge('!', '#c0841a', 'Hay una acción pendiente de aprobación manual.');
        break;
      }

      const claim = await postApi(config, {
        action: 'claim',
        commandId: command.commandId,
      });
      if (!claim.ok) {
        if (claim.status === 'claimed' || claim.status === 'completed') continue;
        throw new Error(claim.error || 'No se pudo reclamar la acción automática.');
      }

      let result;
      try {
        result = await executeApprovedCommand(command, { backgroundTab: true });
      } catch (error) {
        result = {
          ok: false,
          error: error.message || String(error),
        };
      }

      if (result?.snapshot) {
        await postApi(config, {
          action: 'snapshot',
          commandId: command.commandId,
          ...result.snapshot,
        });
      }

      const report = await postApi(config, {
        action: 'result',
        commandId: command.commandId,
        ok: Boolean(result?.ok),
        status: result?.ok ? 'completed' : 'failed',
        result: result || {},
        error: result?.error || '',
      });
      if (!report.ok) throw new Error(report.error || 'No se pudo registrar el resultado automático.');

      if (result?.ok) {
        await setBadge('✓', '#2f855a', 'Última acción automática completada.');
      } else {
        await setBadge('×', '#b91c1c', result?.error || 'La acción automática falló.');
        break;
      }

      await sleep(750);
    }
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

async function executeApprovedCommand(command, options = {}) {
  const targetUrl = command.targetUrl
    || command.payload?.targetUrl
    || command.payload?.alternateLink
    || 'https://classroom.google.com/';

  const backgroundTab = Boolean(options.backgroundTab);
  let tab;
  let createdTab = false;

  if (backgroundTab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: false });
    createdTab = true;
  } else {
    const tabs = await chrome.tabs.query({ url: 'https://classroom.google.com/*' });
    tab = tabs.find((item) => item.active) || tabs[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url: targetUrl, active: true });
      createdTab = true;
    } else {
      tab = await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    }
  }

  try {
    await waitForTab(tab.id, 35000);
    await ensureClassroomReady(tab.id, targetUrl, CLASSROOM_READY_TIMEOUT_MS);
    await ensureContentScript(tab.id);

    const action = String(command?.action || '').toLowerCase();
    if (action === 'open_activity' || action === 'capture_page') {
      const snapshot = await captureClassroomPage(tab.id);
      return { ok: true, action, snapshot };
    }

    startClassroomCommand(tab.id, command);
    return await waitForCommandOutcome(tab.id, command, COMMAND_OUTCOME_TIMEOUT_MS);
  } finally {
    if (backgroundTab && createdTab) {
      try {
        await sleep(1200);
        await chrome.tabs.remove(tab.id);
      } catch (error) {
        // The tab may already be closed. Nothing else is required.
      }
    }
  }
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  await sleep(450);
}

function startClassroomCommand(tabId, command) {
  chrome.tabs.sendMessage(tabId, {
    type: 'execute-classroom-command',
    command,
  }).catch(() => {
    // The content script may finish after its one-shot response channel closes.
    // Completion is verified independently from the rendered Classroom page.
  });
}

async function waitForCommandOutcome(tabId, command, timeoutMs) {
  const started = Date.now();
  const action = String(command?.action || '').toLowerCase();
  let lastState = null;

  while (Date.now() - started < timeoutMs) {
    await sleep(750);
    lastState = await inspectCommandState(tabId, command);

    if (action === 'attach_link' && lastState.attached) {
      return { ok: true, action, snapshot: lastState.snapshot };
    }
    if (action === 'submit' && lastState.submitted) {
      return { ok: true, action, snapshot: lastState.snapshot };
    }
    if (action === 'attach_and_submit' && lastState.attached && lastState.submitted) {
      return { ok: true, action, snapshot: lastState.snapshot };
    }
    if (action === 'reclaim' && lastState.assignable && !lastState.submitted) {
      return { ok: true, action, snapshot: lastState.snapshot };
    }
  }

  const snapshot = lastState?.snapshot || await captureClassroomPage(tabId);
  throw new Error(buildOutcomeError(action, lastState, snapshot));
}

function buildOutcomeError(action, state, snapshot) {
  const details = [];
  if (action === 'attach_link' || action === 'attach_and_submit') {
    details.push(state?.attached ? 'el archivo sí aparece adjunto' : 'el archivo no aparece adjunto');
  }
  if (action === 'submit' || action === 'attach_and_submit') {
    details.push(state?.submitted ? 'la actividad aparece entregada' : 'la actividad no aparece entregada');
  }
  if (action === 'reclaim') {
    details.push(state?.assignable ? 'la actividad volvió a estar asignada' : 'la entrega no se anuló');
  }
  const pageTitle = snapshot?.title ? ` Página: ${snapshot.title}.` : '';
  return `Classroom no confirmó el resultado esperado (${details.join('; ') || action}).${pageTitle}`;
}

async function inspectCommandState(tabId, command) {
  const snapshot = await captureClassroomPage(tabId);
  const normalized = normalize(snapshot.text || '');
  const links = Array.isArray(snapshot.links) ? snapshot.links : [];
  const fileName = String(command?.payload?.fileName || '').trim();
  const fileId = extractDriveFileId(command?.payload?.url || command?.payload?.attachmentUrl || '');

  const submittedLabels = [
    'anular la entrega',
    'anular entrega',
    'cancelar la entrega',
    'cancelar entrega',
    'unsubmit',
    'desmarcar como completada',
    'unmark as done',
  ];
  const assignableLabels = [
    'entregar',
    'turn in',
    'marcar como completada',
    'mark as done',
  ];

  const attachedByName = Boolean(fileName && normalized.includes(normalize(fileName)));
  const attachedById = Boolean(fileId && links.some((item) => String(item.url || '').includes(fileId)));

  return {
    attached: attachedByName || attachedById,
    submitted: submittedLabels.some((label) => normalized.includes(label)),
    assignable: assignableLabels.some((label) => normalized.includes(label)),
    snapshot,
  };
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
    `Classroom abrió la actividad, pero no terminó de mostrar el panel de trabajo. `
      + `URL actual: ${last.url || targetUrl}`,
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
        const loginRequired = /iniciar sesión|sign in/i.test(title + ' ' + bodyText);
        const hasMarker = markers.some((marker) => normalized.includes(marker));
        const assignmentUrl = /\/a\//.test(location.pathname);
        return {
          ready: Boolean(assignmentUrl && hasMarker),
          loginRequired,
          url: location.href,
          title,
          textLength: bodyText.length,
        };
      },
    });
    return results?.[0]?.result || { ready: false, loginRequired: false, url: '' };
  } catch (error) {
    return { ready: false, loginRequired: false, url: '', error: error.message || String(error) };
  }
}

async function captureClassroomPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const isVisible = (node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(isVisible)
        .slice(0, 300)
        .map((anchor) => ({
          text: clean(anchor.innerText || anchor.getAttribute('aria-label') || ''),
          url: anchor.href,
        }))
        .filter((item) => item.text || item.url);
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter(isVisible)
        .slice(0, 150)
        .map((button) => clean(button.innerText || button.getAttribute('aria-label') || ''))
        .filter(Boolean);
      return {
        url: location.href,
        title: document.title,
        text: clean(document.body?.innerText || '').slice(0, 60000),
        links,
        buttons,
      };
    },
  });
  return results?.[0]?.result || { url: '', title: '', text: '', links: [], buttons: [] };
}

function extractDriveFileId(url) {
  const match = String(url || '').match(/\/d\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('es-MX');
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
