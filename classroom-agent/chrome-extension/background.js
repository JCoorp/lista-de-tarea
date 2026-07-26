const POLL_ALARM = 'chatgpt-classroom-agent-poll';
const POLL_MINUTES = 1;
const MAX_COMMANDS_PER_CYCLE = 3;
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
    pollAuthorizedCommands()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
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
    await sleep(backgroundTab ? 2500 : 1500);

    try {
      return await chrome.tabs.sendMessage(tab.id, {
        type: 'execute-classroom-command',
        command,
      });
    } catch (error) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await sleep(700);
      return chrome.tabs.sendMessage(tab.id, {
        type: 'execute-classroom-command',
        command,
      });
    }
  } finally {
    if (backgroundTab && createdTab) {
      try {
        await sleep(1000);
        await chrome.tabs.remove(tab.id);
      } catch (error) {
        // The tab may already be closed. Nothing else is required.
      }
    }
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
