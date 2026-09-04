const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const { initLogging } = require('./logging');
const { createMainWindow } = require('./windows/main-window');
const { onFileSessionOpen, onFileSessionClose } = require('./windows/control-banner');
const {
  showUpdateProgress,
  closeUpdateProgress,
  sendToUpdateWindow,
  isUpdateProgressOpen,
} = require('./windows/update-progress');
const { initAutoUpdater } = require('./updater/auto-updater');
const { buildAppMenu } = require('./app-menu');
const { startWebSocketProxy } = require('./connection/proxy');
const { registerIpcHandlers } = require('./core/ipc-handlers');
const { ConnectionRequestServer } = require('./connection/connection-request');
const { registerFileTransferIpc } = require('./file-transfer/ipc');
const { resolveIdentity, isAllowed } = require('./connection/identity');
const { readConfig } = require('./config/config-manager');

initLogging();

let mainWindow = null;
let wss = null;
let requestServer = null;
let updater = null;

const isDev = process.env.NODE_ENV === 'development';
const PROXY_PORT = 18900;
const UPDATE_CHECK_INTERVAL_MS = parseInt(
  process.env.OPENPORTAL_UPDATE_INTERVAL_MS || (isDev ? 5 * 60 * 1000 : 15 * 60 * 1000),
  10,
);
const ALLOW_PRERELEASE = process.env.OPENPORTAL_ALLOW_PRERELEASE !== 'false';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Diagnóstico de portas: alimentado pelos handlers 'error' de cada
// servidor, para o painel de Configurações mostrar status real em vez de
// assumir que "objeto criado" == "porta realmente aberta" (ver EADDRINUSE).
const portStatus = {
  proxy: { port: PROXY_PORT, listening: false, error: null },
  signal: { port: 18902, listening: false, error: null },
};

async function handleConnectionRequest(req, respond) {
  const { dialog } = require('electron');
  const finish = (approved) =>
    respond({ type: 'connect-response', requestId: req.requestId, approved });

  // Auto-approve a verified, allow-listed Tailscale identity before ever
  // showing the manual dialog. Identity comes from the real socket address
  // (req.remoteAddress), never the self-reported req.fromIp — see
  // connection-request.js. Any resolution failure (Tailscale not installed,
  // whois failure, IP not a tailnet peer) yields 'unknown', which never
  // matches an allow-list entry and falls through to the manual dialog
  // below exactly like today — this never auto-rejects, only auto-approves.
  const { allowedUsers } = readConfig();
  if (Array.isArray(allowedUsers) && allowedUsers.length > 0) {
    const identity = await resolveIdentity(req.remoteAddress);
    if (isAllowed(identity, allowedUsers)) {
      console.log(
        `[main] Auto-approved connection request ${req.requestId} from ${identity} (${req.fromName}, ${req.remoteAddress})`,
      );
      finish(true);
      return;
    }
  }

  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const detail =
    req.capability === 'tunnel'
      ? `IP de origem: ${req.fromIp || 'desconhecido'}\n\nEsse PC poderá ver sua tela e listar, enviar e receber arquivos deste computador. Essa permissão não fica salva — será pedida de novo na próxima vez.\n\nAceita a conexão?`
      : `IP de origem: ${req.fromIp || 'desconhecido'}\n\nAceita a conexão?`;
  const options = {
    type: 'question',
    title: 'Solicitação de conexão',
    message: `${req.fromName} quer se conectar a você.`,
    detail,
    buttons: ['Aceitar', 'Rejeitar'],
    defaultId: 0,
    cancelId: 1,
  };
  const show = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  show.then(({ response }) => finish(response === 0)).catch(() => finish(false));
}

app.whenReady().then(() => {
  console.log('[main] App ready, starting...');
  console.log('[main] Proxy port:', PROXY_PORT);

  mainWindow = createMainWindow(isDev);
  buildAppMenu(() => mainWindow);

  wss = startWebSocketProxy(PROXY_PORT);
  wss.on('listening', () => {
    portStatus.proxy.listening = true;
    portStatus.proxy.error = null;
  });
  wss.on('error', (err) => {
    portStatus.proxy.listening = false;
    portStatus.proxy.error =
      err.code === 'EADDRINUSE'
        ? `Porta ${PROXY_PORT} já está em uso (outra instância do app rodando?)`
        : err.message;
  });

  requestServer = new ConnectionRequestServer((req, respond) =>
    handleConnectionRequest(req, respond),
  );
  requestServer.start();
  requestServer.server.on('listening', () => {
    portStatus.signal.listening = true;
    portStatus.signal.error = null;
  });
  requestServer.server.on('error', (err) => {
    portStatus.signal.listening = false;
    portStatus.signal.error =
      err.code === 'EADDRINUSE'
        ? `Porta ${portStatus.signal.port} já está em uso (outra instância do app rodando?)`
        : err.message;
  });
  requestServer.on('file-session-open', (req) => onFileSessionOpen(req?.fromName));
  requestServer.on('file-session-close', () => onFileSessionClose());

  registerIpcHandlers(mainWindow);
  registerFileTransferIpc(mainWindow);

  // Diagnóstico completo de portas/servidores locais, para o painel de
  // Configurações mostrar status real (sem precisar ler log de terminal).
  ipcMain.handle('diag:getStatus', () => {
    return {
      proxy: { ...portStatus.proxy },
      signal: { ...portStatus.signal },
    };
  });

  updater = initAutoUpdater({
    getMainWindow: () => mainWindow,
    isDev,
    allowPrerelease: ALLOW_PRERELEASE,
    updateCheckIntervalMs: UPDATE_CHECK_INTERVAL_MS,
    windows: {
      showUpdateProgress,
      closeUpdateProgress,
      sendToUpdateWindow,
      isUpdateProgressOpen,
    },
  });

  ipcMain.handle('app:checkUpdate', () => updater.checkForUpdatesManually());

  globalShortcut.register('F12', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  globalShortcut.register('F11', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  globalShortcut.register('F1', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bwc = mainWindow.webContents;
      bwc.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
      bwc.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(isDev);
  });

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (wss) wss.close();
  if (requestServer) requestServer.stop();
  if (updater) updater.stop();
  if (process.platform !== 'darwin') app.quit();
});
