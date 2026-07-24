const SELF_UPDATE_CONFIG = Object.freeze({
  expectedEmail: 'carlosjm.ti23@utsjr.edu.mx',
  rawBaseUrl: 'https://raw.githubusercontent.com/JCoorp/lista-de-tarea/main/',
  files: [
    {
      name: 'Code',
      type: 'SERVER_JS',
      path: 'classroom-bridge/apps-script/Code.gs',
    },
    {
      name: 'Agent',
      type: 'SERVER_JS',
      path: 'classroom-agent/apps-script/Agent.gs',
    },
    {
      name: 'SelfUpdate',
      type: 'SERVER_JS',
      path: 'classroom-agent/apps-script/SelfUpdate.gs',
    },
    {
      name: 'appsscript',
      type: 'JSON',
      path: 'classroom-agent/apps-script/appsscript.json',
    },
  ],
  updateTriggerHandler: 'checkForClassroomAgentUpdates',
  sourceHashProperty: 'CLASSROOM_AGENT_SOURCE_HASH',
  lastUpdateProperty: 'CLASSROOM_AGENT_LAST_UPDATE',
  lastErrorProperty: 'CLASSROOM_AGENT_LAST_ERROR',
  deploymentIdProperty: 'CLASSROOM_AGENT_DEPLOYMENT_ID',
  webAppUrlProperty: 'CLASSROOM_AGENT_WEBAPP_URL',
  deploymentDescription: 'Classroom Agent V2 automatic',
});

/**
 * Activación única. Después de ejecutarla, el proyecto se actualiza desde GitHub
 * y vuelve a desplegarse automáticamente cada hora sin copiar código a mano.
 */
function setupAutomaticUpdates() {
  selfUpdateAssertSchoolAccount_();
  selfUpdateReplaceTrigger_();
  const result = updateClassroomAgentFromGitHub(true);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Revisión horaria utilizada por el activador. */
function checkForClassroomAgentUpdates() {
  return updateClassroomAgentFromGitHub(false);
}

/** Fuerza una actualización y un nuevo despliegue aunque el código no haya cambiado. */
function forceClassroomAgentUpdate() {
  const result = updateClassroomAgentFromGitHub(true);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** Devuelve solo estado operativo; no expone el bridgeToken. */
function getAutomaticUpdateStatus() {
  const props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    sourceHash: props.getProperty(SELF_UPDATE_CONFIG.sourceHashProperty) || '',
    lastUpdate: props.getProperty(SELF_UPDATE_CONFIG.lastUpdateProperty) || '',
    lastError: props.getProperty(SELF_UPDATE_CONFIG.lastErrorProperty) || '',
    deploymentId: props.getProperty(SELF_UPDATE_CONFIG.deploymentIdProperty) || '',
    webAppUrl: props.getProperty(SELF_UPDATE_CONFIG.webAppUrlProperty) || '',
  };
}

function updateClassroomAgentFromGitHub(force) {
  selfUpdateAssertSchoolAccount_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Ya hay una actualización automática en curso.');
  }

  const props = PropertiesService.getScriptProperties();
  try {
    const remoteFiles = selfUpdateDownloadSources_();
    const sourceHash = selfUpdateHashFiles_(remoteFiles);
    const previousHash = props.getProperty(SELF_UPDATE_CONFIG.sourceHashProperty) || '';
    const shouldUpdate = Boolean(force) || sourceHash !== previousHash;

    let contentUpdated = false;
    if (shouldUpdate) {
      selfUpdateProjectContent_(remoteFiles);
      props.setProperty(SELF_UPDATE_CONFIG.sourceHashProperty, sourceHash);
      contentUpdated = true;
    }

    const deployment = selfUpdateDeployCurrentHead_(contentUpdated || Boolean(force));
    const now = new Date().toISOString();
    props.setProperty(SELF_UPDATE_CONFIG.lastUpdateProperty, now);
    props.deleteProperty(SELF_UPDATE_CONFIG.lastErrorProperty);

    return {
      ok: true,
      changed: contentUpdated,
      sourceHash: sourceHash,
      deploymentId: deployment.deploymentId || '',
      webAppUrl: deployment.webAppUrl || '',
      checkedAt: now,
    };
  } catch (error) {
    const message = selfUpdateErrorText_(error);
    props.setProperty(SELF_UPDATE_CONFIG.lastErrorProperty, message);
    throw new Error(message);
  } finally {
    lock.releaseLock();
  }
}

function selfUpdateDownloadSources_() {
  return SELF_UPDATE_CONFIG.files.map(function (file) {
    const separator = file.path.indexOf('?') >= 0 ? '&' : '?';
    const url = SELF_UPDATE_CONFIG.rawBaseUrl + file.path + separator + 'ts=' + Date.now();
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { Accept: 'text/plain' },
    });
    const status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      throw new Error('No se pudo descargar ' + file.path + '. HTTP ' + status);
    }
    const source = response.getContentText('UTF-8');
    if (!source.trim()) throw new Error('GitHub devolvió vacío: ' + file.path);
    if (file.type === 'JSON') JSON.parse(source);
    return {
      name: file.name,
      type: file.type,
      source: source,
    };
  });
}

function selfUpdateHashFiles_(files) {
  const canonical = files.map(function (file) {
    return file.name + '\n' + file.type + '\n' + file.source;
  }).join('\n---CLASSROOM-AGENT-FILE---\n');
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonical,
    Utilities.Charset.UTF_8
  );
  return digest.map(function (value) {
    const normalized = value < 0 ? value + 256 : value;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('');
}

function selfUpdateProjectContent_(files) {
  const scriptId = ScriptApp.getScriptId();
  selfUpdateApiRequest_(
    'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) + '/content',
    'put',
    { files: files }
  );
}

function selfUpdateDeployCurrentHead_(forceNewVersion) {
  const props = PropertiesService.getScriptProperties();
  let deploymentId = props.getProperty(SELF_UPDATE_CONFIG.deploymentIdProperty) || '';
  let deployment = null;

  if (!deploymentId) {
    deployment = selfUpdateFindExistingDeployment_();
    if (deployment) deploymentId = deployment.deploymentId || '';
  }

  if (!forceNewVersion && deploymentId) {
    deployment = selfUpdateGetDeployment_(deploymentId);
    const existingUrl = selfUpdateExtractWebAppUrl_(deployment);
    if (existingUrl) {
      props.setProperty(SELF_UPDATE_CONFIG.webAppUrlProperty, existingUrl);
      return { deploymentId: deploymentId, webAppUrl: existingUrl };
    }
  }

  const version = selfUpdateCreateVersion_();
  if (deploymentId) {
    deployment = selfUpdateUpdateDeployment_(deploymentId, version.versionNumber);
  } else {
    deployment = selfUpdateCreateDeployment_(version.versionNumber);
    deploymentId = deployment.deploymentId || '';
  }

  if (!deploymentId) throw new Error('Google no devolvió un deploymentId.');
  props.setProperty(SELF_UPDATE_CONFIG.deploymentIdProperty, deploymentId);

  let webAppUrl = selfUpdateExtractWebAppUrl_(deployment);
  if (!webAppUrl) {
    Utilities.sleep(1000);
    deployment = selfUpdateGetDeployment_(deploymentId);
    webAppUrl = selfUpdateExtractWebAppUrl_(deployment);
  }
  if (!webAppUrl) throw new Error('La implementación no devolvió una URL de aplicación web.');
  props.setProperty(SELF_UPDATE_CONFIG.webAppUrlProperty, webAppUrl);

  return { deploymentId: deploymentId, webAppUrl: webAppUrl };
}

function selfUpdateCreateVersion_() {
  const scriptId = ScriptApp.getScriptId();
  return selfUpdateApiRequest_(
    'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) + '/versions',
    'post',
    { description: 'Automatic update ' + new Date().toISOString() }
  );
}

function selfUpdateCreateDeployment_(versionNumber) {
  const scriptId = ScriptApp.getScriptId();
  return selfUpdateApiRequest_(
    'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) + '/deployments',
    'post',
    {
      versionNumber: Number(versionNumber),
      manifestFileName: 'appsscript',
      description: SELF_UPDATE_CONFIG.deploymentDescription,
    }
  );
}

function selfUpdateUpdateDeployment_(deploymentId, versionNumber) {
  const scriptId = ScriptApp.getScriptId();
  return selfUpdateApiRequest_(
    'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) +
      '/deployments/' + encodeURIComponent(deploymentId),
    'put',
    {
      deploymentConfig: {
        scriptId: scriptId,
        versionNumber: Number(versionNumber),
        manifestFileName: 'appsscript',
        description: SELF_UPDATE_CONFIG.deploymentDescription,
      },
    }
  );
}

function selfUpdateFindExistingDeployment_() {
  const scriptId = ScriptApp.getScriptId();
  const response = selfUpdateApiRequest_(
    'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) + '/deployments',
    'get'
  );
  const deployments = response.deployments || [];
  return deployments.find(function (deployment) {
    return deployment && deployment.deploymentConfig &&
      deployment.deploymentConfig.description === SELF_UPDATE_CONFIG.deploymentDescription;
  }) || null;
}

function selfUpdateGetDeployment_(deploymentId) {
  const scriptId = ScriptApp.getScriptId();
  return selfUpdateApiRequest_(
    'https://script.googleapis.com/v1/projects/' + encodeURIComponent(scriptId) +
      '/deployments/' + encodeURIComponent(deploymentId),
    'get'
  );
}

function selfUpdateExtractWebAppUrl_(deployment) {
  const entryPoints = deployment && deployment.entryPoints ? deployment.entryPoints : [];
  for (let index = 0; index < entryPoints.length; index += 1) {
    const entry = entryPoints[index] || {};
    if (entry.webApp && entry.webApp.url) return String(entry.webApp.url);
  }
  return '';
}

function selfUpdateApiRequest_(url, method, body) {
  const options = {
    method: method,
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      Accept: 'application/json',
    },
  };
  if (body !== undefined) {
    options.contentType = 'application/json; charset=utf-8';
    options.payload = JSON.stringify(body);
  }

  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  const text = response.getContentText('UTF-8');
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = { raw: text };
    }
  }
  if (status < 200 || status >= 300) {
    const details = parsed.error && parsed.error.message ? parsed.error.message : text;
    throw new Error('Apps Script API HTTP ' + status + ': ' + String(details).slice(0, 1000));
  }
  return parsed;
}

function selfUpdateReplaceTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === SELF_UPDATE_CONFIG.updateTriggerHandler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger(SELF_UPDATE_CONFIG.updateTriggerHandler)
    .timeBased()
    .everyHours(1)
    .create();
}

function selfUpdateAssertSchoolAccount_() {
  const email = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (email !== SELF_UPDATE_CONFIG.expectedEmail.toLowerCase()) {
    throw new Error('Cuenta incorrecta: ' + email);
  }
}

function selfUpdateErrorText_(error) {
  return String(error && error.message ? error.message : error).slice(0, 1500);
}
