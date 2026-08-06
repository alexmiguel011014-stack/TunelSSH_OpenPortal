'use strict';

const { ipcMain, app, Notification } = require('electron');
const { readConfig, writeConfig } = require('../config/config-manager');
const { sendConnectRequest, SIGNAL_PORT } = require('../connection/connection-request');
const { execSync } = require('child_process');
const os = require('os');
const net = require('net');

const PROXY_PORT = 18900;

function send(mainWindow, channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function registerIpcHandlers(mainWindow) {
  ipcMain.handle('config:get', () => {
    return readConfig();
  });

  ipcMain.handle('config:save', (_, config) => {
    return writeConfig(config);
  });

  ipcMain.handle('vnc:connect', (_, machine) => {
    send(mainWindow, 'vnc:status', { state: 'connecting', machineId: machine.id });
    return { success: true };
  });

  ipcMain.handle('vnc:disconnect', () => {
    send(mainWindow, 'vnc:status', { state: 'disconnected' });
    return { success: true };
  });

  ipcMain.handle('vnc:proxyUrl', () => {
    return `ws://127.0.0.1:${PROXY_PORT}`;
  });

  function getLocalTailscaleIp() {
    try {
      const output = execSync('tailscale ip -4', { encoding: 'utf8', timeout: 5000 });
      const ip = output.trim().split('\n')[0];
      if (ip) return ip;
    } catch {}
    try {
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && iface.address.startsWith('100.')) {
            return iface.address;
          }
        }
      }
    } catch {}
    return '';
  }

  ipcMain.handle('connect:request', async (_, host, opts) => {
    try {
      const ip = (host || '').trim();
      if (!ip) throw new Error('EndereÃ§o IP vazio');
      if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) {
        throw new Error('EndereÃ§o IP invÃ¡lido: use o formato 100.x.x.x');
      }
      const fromName = (opts && opts.fromName) || os.hostname() || 'PC';
      const fromIp = (opts && opts.fromIp) || getLocalTailscaleIp();
      const res = await sendConnectRequest(ip, fromName, fromIp);
      return { success: true, approved: res.approved, message: res.message };
    } catch (err) {
      return { success: false, approved: false, message: err.message };
    }
  });

  ipcMain.handle('app:notify', (_, { title, body, silent }) => {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: title || 'OpenPortal', body: body || '', silent: !!silent });
        n.show();
      }
    } catch (err) {
      console.error('Notification error:', err);
    }
  });

  ipcMain.handle('net:test', async (_, { host, port, timeoutMs }) => {
    const target = String(host || '').trim();
    if (!target) return { ok: false, error: 'Sem host' };
    const p = parseInt(port, 10) || 5900;
    const timeout = timeoutMs || 4000;
    return await new Promise((resolve) => {
      const begin = Date.now();
      const socket = net.connect({ host: target, port: p });
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ...result, host: target, port: p, ms: Date.now() - begin });
      };
      socket.setTimeout(timeout);
      socket.on('connect', () => done({ ok: true }));
      socket.on('timeout', () => done({ ok: false, error: 'Timeout' }));
      socket.on('error', (err) => done({ ok: false, error: err.code || err.message }));
    });
  });

  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  ipcMain.handle('server:localIp', () => {
    return { ip: getLocalTailscaleIp() };
  });

}

module.exports = { registerIpcHandlers };
