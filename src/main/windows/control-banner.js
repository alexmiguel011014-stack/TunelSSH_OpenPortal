'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

let controlBannerWindow = null;
let activeSessionCount = 0; // protege o banner contra 2 sessões simultâneas

// Aviso persistente "alguém está conectado" enquanto uma sessão de arquivo
// recebida está ativa. Janela pequena, sempre no topo, canto superior
// direito — não bloqueia o uso do PC, só avisa.
function showControlBanner(fromName) {
  if (controlBannerWindow && !controlBannerWindow.isDestroyed()) {
    controlBannerWindow.webContents.executeJavaScript(`setName(${JSON.stringify(fromName || '')})`).catch(() => {});
    return;
  }
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = 300;
  const win = new BrowserWindow({
    width: winWidth, height: 64,
    x: screenW - winWidth - 12, y: 12,
    resizable: false, movable: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true, transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', '..', '..', 'resources', 'control-banner.html')).then(() => {
    win.webContents.executeJavaScript(`setName(${JSON.stringify(fromName || '')})`).catch(() => {});
  }).catch(() => {});
  win.on('closed', () => { controlBannerWindow = null; });
  controlBannerWindow = win;
}

function hideControlBanner() {
  if (controlBannerWindow && !controlBannerWindow.isDestroyed()) {
    controlBannerWindow.close();
  }
  controlBannerWindow = null;
}

// Chamado quando uma sessão de arquivos abre/fecha (ver connection-request.js).
// É uma aproximação: a sessão VNC em si fala direto com o TightVNC, sem
// passar por este servidor, então não há como observar seu início/fim de
// verdade — mas como o App.jsx abre e fecha a sessão junto com a conexão VNC
// (mesmo clique de conectar/desconectar), esse sinal reflete bem a sessão na prática.
function onFileSessionOpen(fromName) {
  activeSessionCount += 1;
  showControlBanner(fromName);
}

function onFileSessionClose() {
  activeSessionCount = Math.max(0, activeSessionCount - 1);
  if (activeSessionCount === 0) hideControlBanner();
}

module.exports = { onFileSessionOpen, onFileSessionClose, hideControlBanner };
