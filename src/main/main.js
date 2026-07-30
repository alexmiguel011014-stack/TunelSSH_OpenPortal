const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
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

app.whenReady().then(() => {
  console.log('[main] App ready, starting...');
  console.log('[main] Proxy port:', PROXY_PORT);

  wss = startWebSocketProxy(PROXY_PORT);
  fileWss = startFileProxy(18901);

  startFileServer(FILE_SERVER_PORT).then(({ port, rootDir }) => {
    console.log(`[main] File server (agente) listening on TCP ${port}, root: ${rootDir}`);
  }).catch(err => {
    console.error(`[main] Failed to start file server: ${err.message}`);
  });

  registerIpcHandlers(mainWindow);
  createWindow();

  globalShortcut.register('F12', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (wss) wss.close();
  if (fileWss) fileWss.close();
  stopFileServer().then(() => console.log('[main] File server stopped'));
  if (process.platform !== 'darwin') app.quit();
});
