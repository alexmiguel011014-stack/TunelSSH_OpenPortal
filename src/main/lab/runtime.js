'use strict';

// Monta o modo laboratório dentro do processo principal (GOALS 16): o lado do
// PC gerenciado (host), o lado do gerente (manager), os canais IPC e o "Iniciar
// com o Windows". Tudo que é do Electron ou do sistema entra por parâmetro, para
// main.js só chamar isto e os testes usarem peças falsas.

const path = require('path');
const { FailureLimiter } = require('../connection/session-password');
const { createActivityReceiver } = require('./activity-receiver');
const { createEventLog } = require('./event-log');
const { createJournalFeed } = require('./journal-feed');
const { createEnrollmentDialog } = require('./enrollment-dialog');
const fileTransferSession = require('../file-transfer/file-transfer-session');
const { openLabFolder, sendLabRequest } = require('./client');
const { createLabHost } = require('./host');
const { CHANNELS, createLabIpcHandlers, registerLabIpc } = require('./ipc');
const { createStartWithWindows } = require('./login-item');
const { createLabManager } = require('./manager');
const { createServiceClient } = require('./service-client');
const { createServiceControl, resolveServiceExe } = require('./service-control');
const labProvisioning = require('../system/lab-provisioning');

function createLabRuntime({
  app,
  ipcMain,
  store,
  getMainWindow,
  resolveIdentity,
  showDialog,
  drawAttention = () => () => {},
  isAllowedHost,
  hostName,
  sendRequest = sendLabRequest,
  openFolder = openLabFolder,
  adoptFileSession = fileTransferSession.adopt,
  isPackaged = false,
  // GOALS 19: o registro de acessos (um arquivo em userData), quem é de confiança para empurrar
  // eventos antigos (GOALS 4), para onde empurrar os eventos deste PC e como.
  eventLogFile = typeof app.getPath === 'function'
    ? path.join(app.getPath('userData'), 'lab-log.jsonl')
    : null,
  getTrustedLogins = () => [],
  onLegacyActivity = () => {},
  getPushAddresses = async () => [],
  pushEvent = () => {},
  serviceClient = createServiceClient(),
  serviceControl = createServiceControl({
    client: serviceClient,
    provisioning: labProvisioning,
    serviceSource: resolveServiceExe(),
    log: (message) => console.log(`[lab] ${message}`),
  }),
  log = (message) => console.log(`[lab] ${message}`),
}) {
  const send = (channel, data) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  const hostState = () => {
    const lab = store.getLab();
    return { mode: lab.mode, managed: lab.managed, managers: lab.managers };
  };
  const notifyHostChanged = () => send(CHANNELS.hostChanged, hostState());

  // A tela de atividade se atualiza quando chega evento novo (no máximo duas vezes por segundo).
  let logTimer = null;
  const notifyLogChanged = () => {
    if (logTimer) return;
    logTimer = setTimeout(() => {
      logTimer = null;
      send(CHANNELS.logChanged, {});
    }, 400);
    logTimer.unref?.();
  };
  const eventLog = createEventLog({
    file: eventLogFile,
    retentionDays: store.getLab().logRetentionDays,
    onChange: notifyLogChanged,
    log,
  });
  const activityReceiver = createActivityReceiver({
    getRoster: () => store.getLab().roster,
    getTrustedLogins,
    resolveIdentity,
    eventLog,
    onLegacy: onLegacyActivity,
    log,
  });

  const host = createLabHost({
    resolveIdentity,
    limiter: new FailureLimiter(),
    store,
    askEnrollment: createEnrollmentDialog({ showDialog, drawAttention }),
    info: { hostName, appVersion: () => app.getVersion() },
    // O que o serviço sabe (estado do PC, aluno, disco) entra no lab-status.
    getStatusInput: () => serviceControl.hostStatusInput(),
    // Alunos, reserva e pasta (GOALS 18) falam com o serviço pelo mesmo pipe.
    service: serviceClient,
    onEnrolled: notifyHostChanged,
    log,
  });

  const manager = createLabManager({
    store,
    eventLog,
    sendRequest,
    openFolder,
    adoptFileSession,
    isAllowedHost,
    onChange: (snapshot) => send(CHANNELS.status, snapshot),
    log,
  });

  // O diário do serviço deste PC vai, ao vivo, para os gerentes (GOALS 19).
  const journalFeed = createJournalFeed({
    service: serviceClient,
    getTargets: getPushAddresses,
    push: pushEvent,
    hostIdentity: () => ({ hostId: store.getHostId(), hostName: hostName() }),
    log,
  });

  let retentionTimer = null;
  const applyRetention = () => eventLog.applyRetention(store.getLab().logRetentionDays);

  const handlers = createLabIpcHandlers({
    manager,
    store,
    eventLog,
    onManagerRemoved: (login) => host.note('manager-removed', login),
    startWithWindows: createStartWithWindows({ app, isPackaged }),
    serviceControl,
    onHostChanged: notifyHostChanged,
  });
  registerLabIpc({ ipcMain, handlers });

  return {
    // Entregue ao ConnectionRequestServer (mensagens `lab-*` da rede).
    labHandler: (args) => host.handle(args),
    // Um evento empurrado por outro PC (porta de sinalização): só entra se vier de quem pode.
    receiveActivity: (args) => activityReceiver.receive(args),
    start: () => {
      manager.start();
      journalFeed.start();
      applyRetention();
      if (!retentionTimer) {
        retentionTimer = setInterval(applyRetention, 24 * 60 * 60 * 1000);
        retentionTimer.unref?.();
      }
    },
    stop: () => {
      manager.stop();
      journalFeed.stop();
      if (retentionTimer) clearInterval(retentionTimer);
      retentionTimer = null;
    },
    manager,
    eventLog,
    notifyHostChanged,
  };
}

module.exports = { createLabRuntime };
