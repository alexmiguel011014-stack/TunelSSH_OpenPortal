const { app, BrowserWindow, Menu, ipcMain, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { startWebSocketProxy } = require('./proxy');
const { startFileProxy } = require('./file-proxy');
const { startFileServer, stopFileServer, getFileServerStatus } = require('./file-server');
const { registerIpcHandlers } = require('./ipc-handlers');

// Configuração de logs em arquivo
const projectDir = path.join(__dirname, '..', '..');
const outLogPath = path.join(projectDir, 'electron-out.log');
const errLogPath = path.join(projectDir, 'electron-err.log');

const outStream = fs.createWriteStream(outLogPath, { flags: 'a' });
const errStream = fs.createWriteStream(errLogPath, { flags: 'a' });

function writeLog(stream, prefix, args) {
  const msg = args.map(arg => {
    if (arg instanceof Error) return arg.stack;
    return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg;
  }).join(' ');
  const formatted = `[${new Date().toISOString()}] ${prefix}: ${msg}\n`;
  stream.write(formatted);
  process.stdout.write(formatted);
}

console.log = (...args) => writeLog(outStream, 'INFO', args);
console.error = (...args) => writeLog(errStream, 'ERROR', args);

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

let mainWindow = null;
let wss = null;
let fileWss = null;
let updateProgressWindow = null;
let isUserTriggeredUpdate = false;
const FILE_SERVER_PORT = 5001;

const isDev = process.env.NODE_ENV === 'development';
const PROXY_PORT = 18900;

function createWindow() {
  console.log('[main] Creating window...');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenPortal Remote',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173');

    mainWindow.webContents.on('console-message', (event, level, message) => {
      const levels = ['verbose', 'info', 'warning', 'error'];
      if (level >= 2) {
        console.error(`[renderer ${levels[level]}] ${message}`);
      } else {
        console.log(`[renderer ${levels[level]}] ${message}`);
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }

  // Prevent page zoom from affecting sidebar
  mainWindow.webContents.on('zoom-changed', () => {
    mainWindow.webContents.setZoomLevel(0);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Daily update check timer
let updateInterval = null;

function startDailyUpdateCheck() {
  if (!isDev) {
    // Check every 24 hours
    updateInterval = setInterval(() => {
      console.log('[auto-update] Daily check: checking for updates...');
      autoUpdater.checkForUpdates();
    }, 24 * 60 * 60 * 1000);
  }
}

function closeUpdateProgressWindow() {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.close();
  }
  updateProgressWindow = null;
}

function createUpdateProgressWindow() {
  closeUpdateProgressWindow();
  const win = new BrowserWindow({
    width: 420, height: 300, resizable: false,
    title: 'Atualização', backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, '..', '..', 'resources', 'update-progress.html'));
  win.on('closed', () => { updateProgressWindow = null; });
  updateProgressWindow = win;
}

function updateWinJS(code) {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.webContents.executeJavaScript(code).catch(() => {});
  }
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit', label: 'Sair' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar Tudo' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        { role: 'forceReload', label: 'Forçar Recarga' },
        { role: 'toggleDevTools', label: 'Ferramentas do Desenvolvedor' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom Padrão' },
        { role: 'zoomIn', label: 'Aumentar Zoom' },
        { role: 'zoomOut', label: 'Diminuir Zoom' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela Cheia' }
      ]
    },
    {
      label: 'Atualizações',
      submenu: [
        {
          label: 'Verificar atualizações...',
          accelerator: 'CmdOrCtrl+U',
          click: () => {
            if (isDev) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Atualizações',
                message: 'Modo de desenvolvimento: as atualizações só funcionam no app instalado.',
                buttons: ['OK']
              });
            } else {
              isUserTriggeredUpdate = true;
              createUpdateProgressWindow();
              updateWinJS("addLog('Verificando atualizações...')");
              autoUpdater.checkForUpdates();
            }
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Ferramentas do Desenvolvedor',
          accelerator: 'F12',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.webContents.isDevToolsOpened()) {
                mainWindow.webContents.closeDevTools();
              } else {
                mainWindow.webContents.openDevTools({ mode: 'detach' });
              }
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  console.log('[main] App ready, starting...');
  console.log('[main] Proxy port:', PROXY_PORT);

  buildAppMenu();
  wss = startWebSocketProxy(PROXY_PORT);
  fileWss = startFileProxy(18901);

  startFileServer(FILE_SERVER_PORT).then(({ port, rootDir }) => {
    console.log(`[main] File server (agente) listening on TCP ${port}, root: ${rootDir}`);
  }).catch(err => {
    console.error(`[main] Failed to start file server: ${err.message}`);
  });

  registerIpcHandlers(mainWindow);
  createWindow();

  ipcMain.handle('app:checkUpdate', () => {
    if (!isDev) {
      autoUpdater.checkForUpdates();
      return { checking: true };
    }
    return { checking: false, message: 'Auto-update only in production' };
  });

  globalShortcut.register('F12', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  if (!isDev) {
    autoUpdater.logger = console;
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'alexmiguel011014-stack',
      repo: 'TunelSSH_OpenPortal'
    });
    autoUpdater.checkForUpdates();
    startDailyUpdateCheck();

    autoUpdater.on('checking-for-update', () => {
      console.log('[auto-update] Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      console.log('[auto-update] Update available:', info.version);
      if (!updateProgressWindow || updateProgressWindow.isDestroyed()) {
        createUpdateProgressWindow();
      }
      updateWinJS(`addLog('Nova versão ${info.version} encontrada. Baixando...')`);
      updateWinJS(`setStatus('Baixando v${info.version}...')`);
    });

    autoUpdater.on('update-not-available', (info) => {
      console.log('[auto-update] No update available');
      if (isUserTriggeredUpdate) {
        updateWinJS("addLog('Nenhuma atualização disponível')");
        updateWinJS("setStatus('Sistema atualizado')");
        setTimeout(() => {
          closeUpdateProgressWindow();
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Atualizações',
            message: 'Nenhuma atualização disponível. O sistema está atualizado.',
            buttons: ['OK']
          });
          isUserTriggeredUpdate = false;
        }, 1500);
      }
    });

    autoUpdater.on('download-progress', (progress) => {
      const pct = Math.round(progress.percent);
      const speed = (progress.bytesPerSecond / 1024).toFixed(0);
      console.log(`[auto-update] Download: ${pct}% (${speed} KB/s)`);
      updateWinJS(`setProgress(${pct})`);
      updateWinJS(`addLog('Download: ${pct}% (${speed} KB/s)')`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[auto-update] Update downloaded:', info.version);
      updateWinJS(`addLog('Versão ${info.version} baixada com sucesso')`);
      updateWinJS("setStatus('Reiniciando...')");
      setTimeout(() => {
        closeUpdateProgressWindow();
        isUserTriggeredUpdate = false;
        autoUpdater.quitAndInstall();
      }, 2000);
    });

    autoUpdater.on('error', (err) => {
      console.log('[auto-update] Erro:', err.message);
      if (isUserTriggeredUpdate || (updateProgressWindow && !updateProgressWindow.isDestroyed())) {
        updateWinJS(`addLog('Erro: ${err.message.replace(/'/g, "\\'")}')`);
        setTimeout(() => {
          closeUpdateProgressWindow();
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Erro de Atualização',
            message: `Erro ao verificar atualizações: ${err.message}`,
            buttons: ['OK']
          });
          isUserTriggeredUpdate = false;
        }, 2000);
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (wss) wss.close();
  if (fileWss) fileWss.close();
  if (updateInterval) clearInterval(updateInterval);
  stopFileServer().then(() => console.log('[main] File server stopped'));
  if (process.platform !== 'darwin') app.quit();
});
