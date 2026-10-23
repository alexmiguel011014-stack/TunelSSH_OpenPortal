'use strict';

// Liga as contas (GOALS 20) ao Electron: o arquivo cifrado da sessão em userData, o cliente do
// Supabase, os canais IPC e o envio do estado à janela. Tudo que é do Electron entra por parâmetro,
// para main.js só chamar isto e os testes usarem peças falsas.

const path = require('path');
const { createAuthService } = require('./auth-service');
const { loadAuthConfig, describeReason } = require('./config');
const { CHANNELS, createAuthIpcHandlers, registerAuthIpc } = require('./ipc');
const { createSessionStore } = require('./session-store');

function createAuthRuntime({
  app,
  ipcMain,
  safeStorage,
  getMainWindow,
  config = loadAuthConfig(),
  // O supabase-js só é carregado quando há projeto configurado.
  createClient = (...args) => require('@supabase/supabase-js').createClient(...args),
  clientOptions = {},
  log = (message) => console.log(`[auth] ${message}`),
}) {
  const send = (channel, data) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  if (!config.configured && config.reason !== 'missing') {
    log(`contas desligadas: ${describeReason(config.reason)}`);
  }

  const store = createSessionStore({
    file: path.join(app.getPath('userData'), 'auth-session.json'),
    safeStorage,
    log,
  });
  const service = createAuthService({ config, createClient, store, clientOptions, log });
  service.onState((state) => send(CHANNELS.state, state));
  registerAuthIpc({ ipcMain, handlers: createAuthIpcHandlers({ service }) });

  return {
    service,
    config,
    store,
    start: () => service.init().catch((err) => log(`erro ao iniciar: ${err.message}`)),
    stop: () => service.stop(),
  };
}

module.exports = { createAuthRuntime };
