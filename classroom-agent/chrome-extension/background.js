chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'execute-approved-command') {
    executeApprovedCommand(message.command)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return false;
});

async function executeApprovedCommand(command) {
  const targetUrl = command.targetUrl || command.payload?.targetUrl || command.payload?.alternateLink || 'https://classroom.google.com/';
  let tabs = await chrome.tabs.query({ url: 'https://classroom.google.com/*' });
  let tab = tabs.find((item) => item.active) || tabs[0];

  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
  } else {
    tab = await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
  }

  await waitForTab(tab.id, 30000);
  await sleep(1500);

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
    await sleep(500);
    return chrome.tabs.sendMessage(tab.id, {
      type: 'execute-classroom-command',
      command,
    });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
