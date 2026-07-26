(() => {
  if (window.__chatgptClassroomAgentLoaded) return;
  window.__chatgptClassroomAgentLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'execute-classroom-command') return false;
    executeCommand(message.command)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error),
        snapshot: capturePage(),
      }));
    return true;
  });

  async function executeCommand(command) {
    const action = String(command?.action || '').toLowerCase();
    if (action === 'open_activity') {
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'capture_page') {
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'attach_link') {
      await attachLink(
        command.payload?.url || command.payload?.attachmentUrl || '',
        command.payload?.fileName || '',
      );
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'submit') {
      await submitAssignment();
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'attach_and_submit') {
      await attachLink(
        command.payload?.url || command.payload?.attachmentUrl || '',
        command.payload?.fileName || '',
      );
      await submitAssignment();
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'reclaim') {
      await reclaimAssignment();
      return { ok: true, action, snapshot: capturePage() };
    }
    throw new Error(`Acción no compatible: ${action}`);
  }

  async function attachLink(url, fileName = '') {
    if (!/^https?:\/\//i.test(url)) throw new Error('El comando no contiene un enlace válido.');

    const addButton = await waitForText([
      'Añadir o crear',
      'Agregar o crear',
      'Add or create',
    ], 12000, true);
    await activateElement(addButton);

    const linkOption = await waitForText(['Enlace', 'Link'], 8000, true);
    await activateElement(linkOption);

    const dialog = await waitUntil(
      () => findVisibleDialog(),
      8000,
      'No encontré la ventana para agregar el vínculo.',
    );

    const input = await waitForInputWithin(dialog, 8000);
    setInputValue(input, url);

    await waitUntil(
      () => String(input.value || '').trim() === url,
      4000,
      'Classroom no conservó el enlace en el campo de vínculo.',
    );

    await clickUntilEffect(
      () => {
        const currentDialog = findVisibleDialog() || dialog;
        const button = findVisibleByTextWithin(currentDialog, [
          'Agregar un vínculo',
          'Añadir un vínculo',
          'Add link',
        ], true);
        if (!button) return null;
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
        return button;
      },
      () => !document.contains(dialog) || !isVisible(dialog),
      15000,
      'La ventana de vínculo no se cerró después de varios intentos de agregarlo.',
    );

    const fileId = extractDriveFileId(url);
    await waitUntil(() => {
      const visibleText = cleanText(document.body?.innerText || '');
      if (fileName && visibleText.includes(fileName)) return true;
      if (fileId) {
        return Array.from(document.querySelectorAll('a[href]'))
          .filter(isVisible)
          .some((anchor) => String(anchor.href || '').includes(fileId));
      }
      return false;
    }, 20000, 'Classroom no confirmó que el vínculo quedara adjunto.');
  }

  async function submitAssignment() {
    const submitLabels = [
      'Entregar',
      'Turn in',
      'Marcar como completada',
      'Mark as done',
    ];

    if (isSubmittedState()) return;

    const first = await waitForText(submitLabels, 12000, true);
    await activateElement(first);

    const nextStep = await waitUntil(() => {
      if (isSubmittedState()) return { alreadySubmitted: true };

      const dialog = findVisibleDialog();
      if (!dialog) return null;

      const confirmButton = findVisibleByTextWithin(dialog, submitLabels, true);
      return confirmButton ? { confirmButton } : null;
    }, 12000, 'No encontré la ventana de confirmación para entregar o marcar como completada.');

    if (nextStep.confirmButton) {
      await clickUntilEffect(
        () => {
          const dialog = findVisibleDialog();
          return dialog ? findVisibleByTextWithin(dialog, submitLabels, true) : null;
        },
        () => isSubmittedState(),
        18000,
        'Classroom no confirmó la entrega después de varios intentos.',
      );
    }

    await waitUntil(
      () => isSubmittedState(),
      15000,
      'Classroom no confirmó que la actividad quedara entregada o marcada como completada.',
    );
  }

  async function reclaimAssignment() {
    const reclaimLabels = [
      'Anular la entrega',
      'Anular entrega',
      'Cancelar la entrega',
      'Cancelar entrega',
      'Unsubmit',
      'Desmarcar como completada',
      'Unmark as done',
    ];

    if (isAssignableState()) return;

    const first = await waitForText(reclaimLabels, 12000, true);
    await activateElement(first);

    const nextStep = await waitUntil(() => {
      if (isAssignableState()) return { alreadyReclaimed: true };

      const dialog = findVisibleDialog();
      if (!dialog) return null;

      const confirmButton = findVisibleByTextWithin(dialog, reclaimLabels, true);
      return confirmButton ? { confirmButton } : null;
    }, 12000, 'No encontré la ventana de confirmación para anular la entrega.');

    if (nextStep.confirmButton) {
      await clickUntilEffect(
        () => {
          const dialog = findVisibleDialog();
          return dialog ? findVisibleByTextWithin(dialog, reclaimLabels, true) : null;
        },
        () => isAssignableState(),
        18000,
        'Classroom no confirmó la anulación después de varios intentos.',
      );
    }

    await waitUntil(
      () => isAssignableState(),
      15000,
      'Classroom no confirmó que la entrega quedara anulada.',
    );
  }

  function isSubmittedState() {
    return Boolean(findVisibleByText([
      'Anular la entrega',
      'Anular entrega',
      'Cancelar la entrega',
      'Cancelar entrega',
      'Unsubmit',
      'Desmarcar como completada',
      'Unmark as done',
    ], true));
  }

  function isAssignableState() {
    return Boolean(findVisibleByText([
      'Entregar',
      'Turn in',
      'Marcar como completada',
      'Mark as done',
    ], true));
  }

  function findVisibleDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'));
    return dialogs.find(isVisible) || null;
  }

  function capturePage() {
    const links = Array.from(document.querySelectorAll('a[href]'))
      .filter(isVisible)
      .slice(0, 300)
      .map((anchor) => ({
        text: cleanText(anchor.innerText || anchor.getAttribute('aria-label') || ''),
        url: anchor.href,
      }))
      .filter((item) => item.text || item.url);

    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(isVisible)
      .slice(0, 150)
      .map((button) => cleanText(button.innerText || button.getAttribute('aria-label') || ''))
      .filter(Boolean);

    return {
      url: location.href,
      title: document.title,
      text: cleanText(document.body?.innerText || '').slice(0, 60000),
      links,
      buttons,
    };
  }

  function waitForText(labels, timeoutMs, preferButton = false) {
    return waitUntil(() => findVisibleByText(labels, preferButton), timeoutMs, `No encontré: ${labels.join(' / ')}`);
  }

  function waitForInputWithin(root, timeoutMs) {
    return waitUntil(() => {
      const candidates = Array.from(root.querySelectorAll('input[type="url"],input[type="text"],textarea'));
      return candidates.find(isVisible) || null;
    }, timeoutMs, 'No encontré el campo para pegar el enlace dentro de la ventana de vínculo.');
  }

  function findVisibleByText(labels, preferButton = false) {
    return findVisibleByTextWithin(document, labels, preferButton);
  }

  function findVisibleByTextWithin(root, labels, preferButton = false) {
    const normalizedLabels = labels.map(normalize);
    const selectors = preferButton
      ? 'button,[role="button"],[role="menuitem"]'
      : 'button,[role="button"],[role="menuitem"],span,div';
    const nodes = Array.from(root.querySelectorAll(selectors)).filter(isVisible);

    const exact = nodes.find((node) => {
      const text = normalize(node.innerText || node.getAttribute('aria-label') || '');
      return normalizedLabels.includes(text);
    });
    if (exact) return closestInteractive(exact);

    const partial = nodes.find((node) => {
      const text = normalize(node.innerText || node.getAttribute('aria-label') || '');
      return normalizedLabels.some((label) => text === label || text.startsWith(label));
    });
    return partial ? closestInteractive(partial) : null;
  }

  function closestInteractive(node) {
    return node.closest('button,[role="button"],[role="menuitem"]') || node;
  }

  async function activateElement(node) {
    const target = closestInteractive(node);
    target.scrollIntoView({ block: 'center', inline: 'center' });
    try { target.focus({ preventScroll: true }); } catch (error) { target.focus?.(); }

    const mouseOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
    };

    try { target.dispatchEvent(new PointerEvent('pointerdown', mouseOptions)); } catch (error) {}
    target.dispatchEvent(new MouseEvent('mousedown', mouseOptions));
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...mouseOptions, buttons: 0 })); } catch (error) {}
    target.dispatchEvent(new MouseEvent('mouseup', { ...mouseOptions, buttons: 0 }));
    target.click();
    await sleep(350);
  }

  async function clickUntilEffect(getNode, effect, timeoutMs, errorMessage) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (effect()) return true;
      const node = getNode();
      if (node && isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true') {
        await activateElement(node);
      } else {
        await sleep(300);
      }
      if (effect()) return true;
      await sleep(500);
    }
    throw new Error(errorMessage);
  }

  function setInputValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(input, value);
    input.focus();
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    input.blur();
  }

  function extractDriveFileId(url) {
    const match = String(url || '').match(/\/d\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : '';
  }

  function waitUntil(test, timeoutMs, errorMessage) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const value = test();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(errorMessage));
        }
      }, 250);
    });
  }

  function isVisible(node) {
    if (!node) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalize(value) {
    return cleanText(value).toLocaleLowerCase('es-MX');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
