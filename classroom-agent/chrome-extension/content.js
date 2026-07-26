(() => {
  const AGENT_VERSION = '0.3.4';
  if (window.__chatgptClassroomAgentVersion === AGENT_VERSION) return;
  window.__chatgptClassroomAgentVersion = AGENT_VERSION;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'classroom-agent-ping') {
      sendResponse({ ok: true, version: AGENT_VERSION });
      return false;
    }

    if (message?.type === 'execute-classroom-command-detached' || message?.type === 'execute-classroom-command') {
      sendResponse({ ok: true, accepted: true, version: AGENT_VERSION });
      void executeDetached(message.command);
      return false;
    }

    return false;
  });

  async function executeDetached(command) {
    let result;
    try {
      result = await executeCommand(command);
    } catch (error) {
      result = {
        ok: false,
        error: error.message || String(error),
        snapshot: capturePage(),
      };
    }

    try {
      await reportDetachedResult(command?.commandId, result);
    } catch (error) {
      console.error('ChatGPT Classroom Agent no pudo registrar el resultado:', error);
    }
  }

  async function reportDetachedResult(commandId, result) {
    if (!commandId) throw new Error('La acción no contiene commandId.');

    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'classroom-command-finished',
          commandId,
          result,
        });
        if (response?.accepted) return;
        lastError = new Error('El proceso en segundo plano no aceptó el resultado.');
      } catch (error) {
        lastError = error;
      }
      await sleep(750 + attempt * 500);
    }

    throw lastError || new Error('No se pudo registrar el resultado de Classroom.');
  }

  async function executeCommand(command) {
    const action = String(command?.action || '').toLowerCase();
    const fileName = command?.payload?.fileName || '';
    const attachmentUrl = command?.payload?.url || command?.payload?.attachmentUrl || '';

    if (action === 'open_activity') {
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'capture_page') {
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'attach_link') {
      await attachLink(attachmentUrl, fileName);
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'submit') {
      await submitAssignment();
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'attach_and_submit') {
      await attachLink(attachmentUrl, fileName);
      await submitAssignment();
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'reclaim') {
      await reclaimAssignment();
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'remove_attachment') {
      await removeAttachment(fileName, attachmentUrl);
      return { ok: true, action, snapshot: capturePage() };
    }
    if (action === 'reclaim_and_remove_attachment') {
      await reclaimAssignment();
      await removeAttachment(fileName, attachmentUrl);
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
    await waitUntil(
      () => attachmentExists(fileName, fileId),
      20000,
      'Classroom no confirmó que el vínculo quedara adjunto.',
    );
  }

  async function submitAssignment() {
    const submitLabels = [
      'Entregar',
      'Turn in',
      'Marcar como completada',
      'Mark as done',
      'Entregar trabajo',
      'Turn in assignment',
    ];

    if (isSubmittedState()) return;

    const firstButton = await waitForText(submitLabels, 12000, true);

    await clickUntilEffect(
      () => {
        if (firstButton && document.contains(firstButton) && isVisible(firstButton)) return firstButton;
        return findVisibleByText(submitLabels, true);
      },
      () => isSubmittedState() || Boolean(findConfirmationButton(submitLabels, firstButton)),
      15000,
      'Classroom no reaccionó al botón para entregar la actividad.',
    );

    if (isSubmittedState()) return;

    await clickUntilEffect(
      () => findConfirmationButton(submitLabels, firstButton),
      () => isSubmittedState(),
      20000,
      'Classroom no confirmó la entrega después de varios intentos.',
    );

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

  async function removeAttachment(fileName = '', url = '') {
    if (isSubmittedState()) {
      throw new Error('La entrega sigue enviada; primero debe anularse antes de eliminar el archivo adjunto.');
    }

    const fileId = extractDriveFileId(url);
    if (!attachmentExists(fileName, fileId)) return;

    const removeButton = await waitUntil(
      () => findRemoveAttachmentButton(fileName, fileId),
      12000,
      'No encontré el botón para eliminar el archivo adjunto.',
    );

    await activateElement(removeButton);

    const confirmLabels = [
      'Eliminar',
      'Quitar',
      'Remove',
      'Delete',
      'Eliminar archivo adjunto',
      'Quitar archivo adjunto',
    ];

    await sleep(500);
    if (attachmentExists(fileName, fileId)) {
      const dialog = findVisibleDialog();
      const confirmButton = dialog
        ? findVisibleByTextWithin(dialog, confirmLabels, true)
        : null;
      if (confirmButton && confirmButton !== removeButton) {
        await activateElement(confirmButton);
      }
    }

    await waitUntil(
      () => !attachmentExists(fileName, fileId),
      20000,
      'Classroom no confirmó que el archivo adjunto fuera eliminado.',
    );
  }

  function attachmentExists(fileName = '', fileId = '') {
    const normalizedName = normalize(fileName);
    const nameStem = normalizedName.replace(/\.[a-z0-9]{1,8}$/i, '');

    if (fileId) {
      const matchingAnchor = Array.from(document.querySelectorAll('a[href]'))
        .filter(isVisible)
        .some((anchor) => String(anchor.href || '').includes(fileId));
      if (matchingAnchor) return true;
    }

    if (normalizedName) {
      const bodyText = normalize(document.body?.innerText || '');
      if (bodyText.includes(normalizedName)) return true;
      if (nameStem.length >= 12 && bodyText.includes(nameStem)) return true;
    }

    return false;
  }

  function findRemoveAttachmentButton(fileName = '', fileId = '') {
    const normalizedName = normalize(fileName);
    const nameStem = normalizedName.replace(/\.[a-z0-9]{1,8}$/i, '');
    const removeWords = ['eliminar', 'quitar', 'remove', 'delete'];
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(isVisible)
      .map(closestInteractive)
      .filter((node, index, all) => all.indexOf(node) === index)
      .filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true');

    const direct = buttons.find((button) => {
      const text = normalize(button.innerText || button.getAttribute('aria-label') || '');
      const isRemove = removeWords.some((word) => text.includes(word));
      if (!isRemove) return false;
      if (!normalizedName && !fileId) return true;
      if (normalizedName && text.includes(normalizedName)) return true;
      if (nameStem.length >= 12 && text.includes(nameStem)) return true;
      return false;
    });
    if (direct) return direct;

    if (fileId) {
      const anchor = Array.from(document.querySelectorAll('a[href]'))
        .filter(isVisible)
        .find((item) => String(item.href || '').includes(fileId));
      if (anchor) {
        let container = anchor;
        for (let level = 0; level < 6 && container; level += 1) {
          const candidate = Array.from(container.querySelectorAll?.('button,[role="button"]') || [])
            .filter(isVisible)
            .find((button) => {
              const text = normalize(button.innerText || button.getAttribute('aria-label') || '');
              return removeWords.some((word) => text.includes(word));
            });
          if (candidate) return closestInteractive(candidate);
          container = container.parentElement;
        }
      }
    }

    return buttons.find((button) => {
      const text = normalize(button.innerText || button.getAttribute('aria-label') || '');
      return removeWords.some((word) => text.startsWith(word));
    }) || null;
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
    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"],[role="alertdialog"],[aria-modal="true"]',
    ));
    return dialogs.find(isVisible) || null;
  }

  function findConfirmationButton(labels, originalButton) {
    const normalizedLabels = labels.map(normalize);
    const candidates = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(isVisible)
      .map(closestInteractive)
      .filter((node, index, all) => all.indexOf(node) === index)
      .filter((node) => {
        const text = normalize(node.innerText || node.getAttribute('aria-label') || '');
        return normalizedLabels.some((label) => text === label || text.includes(label));
      })
      .filter((node) => node !== originalButton)
      .filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true');

    if (!candidates.length) return null;

    const modalCandidate = candidates.find((node) => node.closest(
      '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[data-mdc-dialog-action]',
    ));
    if (modalCandidate) return modalCandidate;

    return candidates[candidates.length - 1];
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

    const partialMatches = nodes
      .map((node) => ({
        node,
        text: normalize(node.innerText || node.getAttribute('aria-label') || ''),
      }))
      .filter(({ text }) => normalizedLabels.some((label) => text.includes(label)))
      .sort((a, b) => a.text.length - b.text.length);

    return partialMatches.length ? closestInteractive(partialMatches[0].node) : null;
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
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
    } catch (error) {}
    await sleep(500);
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
      await sleep(600);
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
