'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');

function createMainWindow(isDev) {
  console.log('[main] Creating window...');

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenPortal Remote',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

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
    mainWindow.loadFile(path.join(__dirname, '..', '..', '..', 'dist', 'renderer', 'index.html'));
  }

  // Prevent page zoom from affecting sidebar
  mainWindow.webContents.on('zoom-changed', () => {
    mainWindow.webContents.setZoomLevel(0);
  });

  // Fechar a janela encerra o app e tira este PC do ar para quem conecta. Em
  // 2026-09-24 o app de um PC saiu duas vezes sem erro por esse caminho: o log
  // registra o fechamento, o fim de sessão do Windows e uma queda da tela.
  mainWindow.on('close', () => console.log('[main] Janela principal fechando'));
  mainWindow.on('session-end', () =>
    console.log('[main] Sessão do Windows terminando (logoff ou desligamento)'),
  );
  mainWindow.webContents.on('render-process-gone', (_event, details) =>
    console.error(`[main] Processo da tela caiu: ${details.reason} (código ${details.exitCode})`),
  );

  return mainWindow;
}

module.exports = { createMainWindow };
