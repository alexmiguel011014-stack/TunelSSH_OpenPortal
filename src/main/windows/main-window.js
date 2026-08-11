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

  return mainWindow;
}

module.exports = { createMainWindow };
