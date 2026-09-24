const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Notification,
  powerMonitor,
} = require('electron');
const os = require('os');
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
const { ConnectionRequestServer, sendActivityEvent } = require('./connection/connection-request');
const { registerFileTransferIpc } = require('./file-transfer/ipc');
const {
  resolveIdentity,
  isAllowed,
  resolveLoginToIp,
  normalizeIp,
} = require('./connection/identity');
const { SessionPasswordGate } = require('./connection/session-password');
const { VncTunnelTokens } = require('./connection/vnc-tunnel');
const fileTransferSession = require('./file-transfer/file-transfer-session');
const { getHostVncPassword, getHostVncState, readConfig } = require('./config/config-manager');
const { addActivityEntry } = require('./config/activity-log');
const { sendTelegramAlert } = require('./activity/telegram');

initLogging();

let mainWindow = null;
let wss = null;
let requestServer = null;
let updater = null;
// Senha de acesso exibida na tela inicial (ver session-password.js).
const accessGate = new SessionPasswordGate();
// GOALS 10: token do túnel VNC por aprovação (requestId -> token), revogado
// quando a sessão aprovada fecha.
const vncTunnelTokens = new VncTunnelTokens();
const tunnelTokenByRequest = new Map();

const isDev = process.env.NODE_ENV === 'development';
const PROXY_PORT = 18900;
const UPDATE_CHECK_INTERVAL_MS = parseInt(
  process.env.OPENPORTAL_UPDATE_INTERVAL_MS || (isDev ? 5 * 60 * 1000 : 15 * 60 * 1000),
  10,
);
const ALLOW_PRERELEASE = process.env.OPENPORTAL_ALLOW_PRERELEASE !== 'false';

// Outra instância deste app já está aberta: ela recebe 'second-instance' e vem
// para a frente. Esta sai sem abrir janela nem portas — antes o whenReady
// abaixo rodava mesmo assim e batia EADDRINUSE nas 18900/18902 antes de fechar.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  console.log('[main] Outra instância do OpenPortal já está aberta; esta vai fechar.');
  app.quit();
}

// Diagnóstico de portas: alimentado pelos handlers 'error' de cada
// servidor, para o painel de Configurações mostrar status real em vez de
// assumir que "objeto criado" == "porta realmente aberta" (ver EADDRINUSE).
const portStatus = {
  proxy: { port: PROXY_PORT, listening: false, error: null },
  signal: { port: 18902, listening: false, error: null },
};

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// GOALS 4: requestId -> { startedAt, identity } enquanto a sessão de
// arquivos está aberta, só para calcular a duração no fechamento — não
// precisa sobreviver a um restart do app (uma sessão não atravessa isso).
const activitySessions = new Map();

// Sessão de arquivos fechou: monta o evento de atividade e dispara
// best-effort para cada `reportTo` (push) e, se habilitado, Telegram. Nunca
// bloqueia o fechamento real da sessão — tudo aqui é fire-and-forget e
// nenhuma falha de rede/Telegram propaga para fora desta função.
function reportSessionActivity(req) {
  const started = activitySessions.get(req.requestId);
  activitySessions.delete(req.requestId);
  if (!started) return;

  const event = {
    identity: started.identity,
    machineName: os.hostname(),
    startedAt: started.startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - started.startedAt,
    filesTransferred: req.filesTransferred || 0,
  };

  const config = readConfig();
  const reportTo = Array.isArray(config.reportTo) ? config.reportTo : [];
  (async () => {
    for (const login of reportTo) {
      try {
        const ip = await resolveLoginToIp(login);
        if (ip) sendActivityEvent(ip, event);
      } catch (err) {
        console.error(`[main] Failed to push activity to ${login}:`, err.message);
      }
    }
  })();

  if (config.telegram?.enabled) {
    sendTelegramAlert(config.telegram, event).catch((err) =>
      console.error('[main] Telegram alert failed:', err.message),
    );
  }
}

// Pedido de acesso com o app minimizado ou atrás de outras janelas: a janela
// modal de aprovação ficava invisível e o pedido expirava no outro PC.
function drawAttention(win) {
  if (!win) return () => {};
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.flashFrame(true);
  return () => {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(false);
    win.flashFrame(false);
  };
}

async function handleConnectionRequest(req, respond, signal, sessionPassword) {
  const { dialog } = require('electron');
  const logDecision = (decision) =>
    console.log(
      `[main] Pedido de acesso ${req.requestId} de ${req.fromName} (${req.remoteAddress}): ${decision}`,
    );
  // Aprovado: a senha do TightVNC deste PC (quando o app a gerencia) segue na
  // resposta, pelo túnel Tailscale, para quem pediu não precisar digitá-la.
  const finish = (approved, extra = {}) => {
    const vncPassword = approved ? getHostVncPassword() : '';
    // Só pedidos que viram sessão ('tunnel') recebem token — é o fechamento
    // dessa sessão que o revoga — e só se o TightVNC deste PC foi confirmado
    // aceitando conexões locais; senão o túnel não teria onde chegar e quem
    // pediu segue pelo caminho antigo (5900 direto).
    let vncToken = '';
    if (approved && req.capability === 'tunnel' && getHostVncState().localOnly) {
      vncToken = vncTunnelTokens.issue(normalizeIp(req.remoteAddress));
      tunnelTokenByRequest.set(req.requestId, vncToken);
    }
    respond({
      type: 'connect-response',
      requestId: req.requestId,
      approved,
      ...(vncPassword ? { vncPassword } : {}),
      ...(vncToken ? { vncToken } : {}),
      ...extra,
    });
  };

  // Resolvido sempre (não só quando allowedUsers existe): GOALS 4 usa essa
  // identidade verificada para atribuir sessões no log de atividade, mesmo
  // em conexões aprovadas manualmente. Identity vem do IP real do socket
  // (req.remoteAddress), nunca do req.fromIp auto-declarado — ver
  // connection-request.js. Qualquer falha de resolução (Tailscale não
  // instalado, whois falhou, IP não é peer da tailnet) vira 'unknown', que
  // nunca casa com a allow-list nem é útil como identidade de atividade.
  req.identity = await resolveIdentity(req.remoteAddress);
  // Quem pediu já desistiu enquanto a identidade era resolvida.
  if (signal?.aborted) {
    logDecision('abandonado por quem pediu');
    return;
  }

  // Senha de acesso da tela inicial: certa entra sem clique (e a senha muda);
  // errada é recusada, e várias erradas bloqueiam o IP por alguns minutos.
  if (sessionPassword) {
    const verdict = accessGate.check(normalizeIp(req.remoteAddress), sessionPassword);
    if (verdict === 'ok') {
      logDecision('aprovado pela senha de acesso');
      finish(true);
      accessGate.rotate();
      return;
    }
    const locked = verdict === 'locked';
    logDecision(
      locked
        ? 'recusado (IP bloqueado por senhas erradas)'
        : 'recusado (senha de acesso incorreta)',
    );
    finish(false, {
      message: locked
        ? 'Muitas senhas de acesso erradas: aguarde alguns minutos e tente de novo'
        : 'Senha de acesso incorreta',
    });
    return;
  }

  const { allowedUsers } = readConfig();
  if (
    Array.isArray(allowedUsers) &&
    allowedUsers.length > 0 &&
    isAllowed(req.identity, allowedUsers)
  ) {
    console.log(
      `[main] Auto-approved connection request ${req.requestId} from ${req.identity} (${req.fromName}, ${req.remoteAddress})`,
    );
    finish(true);
    return;
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
    // Fecha a janela sozinha se o PC que pediu desistir (timeout/cancelou).
    signal,
  };
  const releaseAttention = drawAttention(parent);
  const show = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  show
    .then(({ response }) => {
      const approved = !signal?.aborted && response === 0;
      let decision = approved ? 'aprovado manualmente' : 'recusado manualmente';
      if (signal?.aborted) decision = 'abandonado por quem pediu';
      logDecision(decision);
      finish(approved);
    })
    .catch(() => finish(false))
    .finally(releaseAttention);
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  console.log('[main] App ready, starting...');
  console.log('[main] Proxy port:', PROXY_PORT);

  mainWindow = createMainWindow(isDev);
  buildAppMenu(() => mainWindow);

  // Suspensão, retomada e troca de fonte de energia no log, para cruzar com
  // quedas do app (o PC B hiberna sozinho e trocou de fonte nas duas quedas).
  for (const event of [
    'suspend',
    'resume',
    'on-ac',
    'on-battery',
    'lock-screen',
    'unlock-screen',
  ]) {
    powerMonitor.on(event, () => console.log(`[power] ${event}`));
  }

  wss = startWebSocketProxy(PROXY_PORT, {
    getTunnelToken: (host) => fileTransferSession.getVncTunnelToken(host),
  });
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

  requestServer = new ConnectionRequestServer(
    (req, respond, signal, sessionPassword) =>
      handleConnectionRequest(req, respond, signal, sessionPassword),
    {
      authorizeVncTunnel: (token, remoteAddress) => {
        const ip = normalizeIp(remoteAddress);
        const verdict = vncTunnelTokens.check(token, ip);
        if (verdict !== 'ok') console.log(`[main] Túnel VNC recusado para ${ip}: ${verdict}`);
        return verdict;
      },
    },
  );
  requestServer.start();
  requestServer.server.on('listening', () => {
    portStatus.signal.listening = true;
    portStatus.signal.error = null;
  });
  let warnedSignalInUse = false;
  requestServer.server.on('error', (err) => {
    portStatus.signal.listening = false;
    portStatus.signal.error =
      err.code === 'EADDRINUSE'
        ? `Porta ${portStatus.signal.port} já está em uso (outra instância do app rodando?)`
        : err.message;
    // O servidor tenta de novo sozinho; o aviso explica por que pedidos de
    // acesso não chegam a ESTA janela enquanto a outra cópia estiver aberta.
    if (err.code === 'EADDRINUSE' && !warnedSignalInUse) {
      warnedSignalInUse = true;
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: 'OpenPortal: porta 18902 ocupada',
            body: 'Outra cópia do OpenPortal (ex.: a versão instalada) está aberta. Pedidos de acesso só chegam a esta janela depois que ela for fechada.',
          }).show();
        }
      } catch {}
    }
  });
  requestServer.on('file-session-open', (req) => {
    onFileSessionOpen(req?.fromName);
    activitySessions.set(req.requestId, {
      startedAt: Date.now(),
      identity: req.identity || 'unknown',
    });
  });
  requestServer.on('file-session-close', (req) => {
    onFileSessionClose();
    vncTunnelTokens.revoke(tunnelTokenByRequest.get(req.requestId));
    tunnelTokenByRequest.delete(req.requestId);
    reportSessionActivity(req);
  });
  requestServer.on('activity-event', (event) => {
    addActivityEntry(event);
    send('activity:new', event);
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Nova atividade',
          body: `${event.identity} conectou-se a ${event.machineName}`,
        }).show();
      }
    } catch (err) {
      console.error('[main] Notification error:', err.message);
    }
  });

  registerIpcHandlers(mainWindow, { accessGate });
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
  console.log('[main] Todas as janelas fechadas; o app vai encerrar');
  globalShortcut.unregisterAll();
  if (wss) wss.close();
  if (requestServer) requestServer.stop();
  if (updater) updater.stop();
  if (process.platform !== 'darwin') app.quit();
});
