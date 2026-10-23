'use strict';

// Liga "Meu acesso" (GOALS 21) ao Electron: o serviço do aluno e do professor, os canais IPC, o
// envio das mudanças à janela e o publicador de acessos que o modo laboratório chama depois de
// reservar, estender ou encerrar. Tudo do Electron entra por parâmetro, como em lab/runtime.js.

const { createHandoverPublisher } = require('../lab/handover-publisher');
const { createAccessService } = require('./access-service');
const { CHANNELS, createAccessIpcHandlers, registerAccessIpc } = require('./ipc');
const { createRdpLauncher } = require('./rdp-file');

function createAccessRuntime({
  ipcMain,
  authService,
  getMainWindow,
  clipboard,
  rdpLauncher = createRdpLauncher({ log: (message) => console.log(`[access] ${message}`) }),
  log = (message) => console.log(`[access] ${message}`),
}) {
  const send = (channel, data) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  };

  const service = createAccessService({
    auth: authService,
    clipboard,
    rdpLauncher,
    onMineChanged: (access) => send(CHANNELS.mineChanged, access),
    log,
  });

  // Só um professor aprovado, com o servidor de contas configurado, publica acessos.
  const handovers = createHandoverPublisher({
    getContext: () => {
      const state = authService.getState();
      const client = authService.getClient();
      if (!client || (state.status !== 'signed-in' && state.status !== 'offline')) return null;
      if (state.profile?.role !== 'professor') return null;
      return { client, profile: state.profile };
    },
    log,
  });

  registerAccessIpc({ ipcMain, handlers: createAccessIpcHandlers({ service }) });

  // O aluno acompanha o acesso enquanto estiver conectado; ao sair (ou virar professor) para.
  const unsubscribe = authService.onState(() => service.syncWatching());

  return {
    service,
    handovers,
    start: () => service.syncWatching(),
    stop: () => {
      unsubscribe();
      service.stop();
    },
  };
}

module.exports = { createAccessRuntime };
