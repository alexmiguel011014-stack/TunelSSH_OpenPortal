'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');

let updateProgressWindow = null;

function closeUpdateProgress() {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.close();
  }
  updateProgressWindow = null;
}

function showUpdateProgress() {
  closeUpdateProgress();
  const win = new BrowserWindow({
    width: 420, height: 300, resizable: false,
    title: 'Atualização', backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, '..', '..', '..', 'resources', 'update-progress.html'));
  win.on('closed', () => { updateProgressWindow = null; });
  updateProgressWindow = win;
  return win;
}

function sendToUpdateWindow(js) {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.webContents.executeJavaScript(js).catch(() => {});
  }
}

function isUpdateProgressOpen() {
  return !!(updateProgressWindow && !updateProgressWindow.isDestroyed());
}

module.exports = { showUpdateProgress, closeUpdateProgress, sendToUpdateWindow, isUpdateProgressOpen };
