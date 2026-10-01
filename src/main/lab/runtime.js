'use strict';

// Monta o modo laboratório dentro do processo principal (GOALS 16): o lado do
// PC gerenciado (host), o lado do gerente (manager), os canais IPC e o "Iniciar
// com o Windows". Tudo que é do Electron ou do sistema entra por parâmetro, para
// main.js só chamar isto e os testes usarem peças falsas.

const { FailureLimiter } = require('../connection/session-password');
const { createEnrollmentDialog } = require('./enrollment-dialog');
const { sendLabRequest } = require('./client');
const { createLabHost } = require('./host');
const { CHANNELS, createLabIpcHandlers, registerLabIpc } = require('./ipc');
const { createStartWithWindows } = require('./login-item');
const { createLabManager } = require('./manager');

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
  isPackaged = false,
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

  const host = createLabHost({
    resolveIdentity,
    limiter: new FailureLimiter(),
    store,
    askEnrollment: createEnrollmentDialog({ showDialog, drawAttention }),
    info: { hostName, appVersion: () => app.getVersion() },
    onEnrolled: notifyHostChanged,
    log,
  });

  const manager = createLabManager({
    store,
    sendRequest,
    isAllowedHost,
    onChange: (snapshot) => send(CHANNELS.status, snapshot),
    log,
  });

  const handlers = createLabIpcHandlers({
    manager,
    store,
    startWithWindows: createStartWithWindows({ app, isPackaged }),
    onHostChanged: notifyHostChanged,
  });
  registerLabIpc({ ipcMain, handlers });

  return {
    // Entregue ao ConnectionRequestServer (mensagens `lab-*` da rede).
    labHandler: (args) => host.handle(args),
    start: () => manager.start(),
    stop: () => manager.stop(),
    manager,
    notifyHostChanged,
  };
}

module.exports = { createLabRuntime };
