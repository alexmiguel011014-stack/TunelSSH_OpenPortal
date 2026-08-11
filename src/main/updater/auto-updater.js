'use strict';

const { dialog } = require('electron');

let _autoUpdater = null;
function getAutoUpdater() {
  if (!_autoUpdater) {
    _autoUpdater = require('electron-updater').autoUpdater;
  }
  return _autoUpdater;
}

function initAutoUpdater({ getMainWindow, isDev, allowPrerelease, updateCheckIntervalMs, windows }) {
  const { showUpdateProgress, closeUpdateProgress, sendToUpdateWindow, isUpdateProgressOpen } = windows;

  let updateInterval = null;
  let isUserTriggeredUpdate = false;
  let dismissedVersion = null; // versão que o usuário já recusou — não perguntar de novo sozinho
  let promptOpen = false; // evita dois dialogs de update simultâneos (check manual + periódico)
  let updateConfirmed = false;

  function startDailyUpdateCheck() {
    if (!isDev) {
      console.log(`[auto-update] Periodic check every ${Math.round(updateCheckIntervalMs / 60000)} min`);
      updateInterval = setInterval(() => {
        console.log('[auto-update] Periodic check: checking for updates...');
        getAutoUpdater().checkForUpdates();
      }, updateCheckIntervalMs);
    }
  }

  function beginUpdateDownload(info) {
    updateConfirmed = true;
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    if (!isUpdateProgressOpen()) {
      showUpdateProgress();
    }
    sendToUpdateWindow(`addLog('Baixando v${info.version}...')`);
    sendToUpdateWindow(`setStatus('Baixando v${info.version}...')`);
    sendToUpdateWindow('setProgress(0)');
    getAutoUpdater().downloadUpdate();
  }

  function promptUpdate(info) {
    // Sem isso, o check automático (a cada 15 min) reabre o mesmo popup
    // repetidamente — tanto para uma versão já recusada quanto em cima de
    // um prompt/download já em andamento (ex.: check manual concorrente).
    if (promptOpen || updateConfirmed) return;
    if (!isUserTriggeredUpdate && info.version === dismissedVersion) return;

    const options = {
      type: 'info',
      title: 'Atualização disponível',
      message: `Nova versão ${info.version} disponível.`,
      detail: 'Deseja baixar e instalar agora? O aplicativo será fechado durante a instalação e reaberto automaticamente ao final.',
      buttons: ['Baixar agora', 'Agora não'],
      defaultId: 0,
      cancelId: 1
    };
    const target = getMainWindow();
    const validTarget = (target && !target.isDestroyed()) ? target : null;
    if (!validTarget) {
      beginUpdateDownload(info);
      return;
    }
    promptOpen = true;
    dialog.showMessageBox(validTarget, options).then(({ response }) => {
      promptOpen = false;
      if (response === 0) {
        beginUpdateDownload(info);
      } else {
        dismissedVersion = info.version;
        closeUpdateProgress();
        isUserTriggeredUpdate = false;
      }
    }).catch(() => {
      promptOpen = false;
      closeUpdateProgress();
      isUserTriggeredUpdate = false;
    });
  }

  function checkForUpdatesManually() {
    if (isDev) {
      return { checking: false, message: 'Auto-update only in production' };
    }
    isUserTriggeredUpdate = true;
    if (!isUpdateProgressOpen()) {
      showUpdateProgress();
    }
    sendToUpdateWindow("addLog('Verificando atualizações...')");
    sendToUpdateWindow("setStatus('Verificando...')");
    getAutoUpdater().checkForUpdates();
    return { checking: true };
  }

  if (!isDev) {
    const autoUpdater = getAutoUpdater();
    autoUpdater.logger = console;
    autoUpdater.autoDownload = false;
    autoUpdater.allowPrerelease = allowPrerelease;
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
      promptUpdate(info);
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[auto-update] No update available');
      if (isUserTriggeredUpdate) {
        sendToUpdateWindow("addLog('Nenhuma atualização disponível')");
        sendToUpdateWindow("setStatus('Sistema atualizado')");
        setTimeout(() => {
          closeUpdateProgress();
          const mainWindow = getMainWindow();
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
      sendToUpdateWindow(`setProgress(${pct})`);
      sendToUpdateWindow(`addLog('Download: ${pct}% (${speed} KB/s)')`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[auto-update] Update downloaded:', info.version);
      sendToUpdateWindow(`addLog('Versão ${info.version} baixada com sucesso')`);
      sendToUpdateWindow("setStatus('Reiniciando...')");
      setTimeout(() => {
        closeUpdateProgress();
        isUserTriggeredUpdate = false;
        autoUpdater.quitAndInstall();
      }, 2000);
    });

    autoUpdater.on('error', (err) => {
      console.log('[auto-update] Erro:', err.message);
      if (isUserTriggeredUpdate || isUpdateProgressOpen()) {
        sendToUpdateWindow(`addLog('Erro: ${err.message.replace(/'/g, "\\'")}')`);
        setTimeout(() => {
          closeUpdateProgress();
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
          }
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

  function stop() {
    if (updateInterval) clearInterval(updateInterval);
  }

  return { checkForUpdatesManually, stop };
}

module.exports = { initAutoUpdater };
