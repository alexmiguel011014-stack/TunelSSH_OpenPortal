'use strict';

const { ipcMain, app, Notification } = require('electron');
const { readConfig, writeConfig } = require('../config/config-manager');
const { readHistory, addEntry } = require('../config/history-manager');
const { readActivityLog } = require('../config/activity-log');
const { execSync } = require('child_process');
const os = require('os');
const net = require('net');
const { startRdpSidecar, sendRdpCommand, stopRdpSidecar } = require('../connection/rdp-sidecar');
const {
  buildConnectCommand,
  buildResizeCommand,
  buildDisconnectCommand,
  buildVisibilityCommand,
} = require('../connection/rdp-protocol');
const {
  enableRdpHosting,
  createRdpCredential,
  generatePassword,
} = require('../system/rdp-provisioning');

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

  ipcMain.handle('history:get', () => {
    return readHistory();
  });

  ipcMain.handle('history:add', (_, entry) => {
    return addEntry(entry);
  });

  ipcMain.handle('activity:get', () => {
    return readActivityLog();
  });

  ipcMain.handle('vnc:connect', (_, machine) => {
    send(mainWindow, 'vnc:status', {
      state: 'connecting',
      machineId: machine.id,
    });
    return { success: true };
  });

  ipcMain.handle('vnc:disconnect', (_, machineId) => {
    send(mainWindow, 'vnc:status', { state: 'disconnected', machineId });
    return { success: true };
  });

  ipcMain.handle('vnc:proxyUrl', () => {
    return `ws://127.0.0.1:${PROXY_PORT}`;
  });

  // HWND do BrowserWindow como string decimal — é isso que a sidecar C#
  // espera no argv (long.TryParse, ver sidecar/Program.cs). O buffer nativo
  // é little-endian; 8 bytes no Windows x64 (ponteiro de 64 bits), mas lemos
  // defensivamente também o caso de 4 bytes.
  function getParentHwnd() {
    const buf = mainWindow.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    if (buf.length >= 4) return String(buf.readUInt32LE(0));
    return '0';
  }

  ipcMain.handle('rdp:start', async (_, { machine, rect }) => {
    const ok = await startRdpSidecar(machine.id, {
      parentHwnd: getParentHwnd(),
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
    if (ok === null) return { success: false, superseded: true };
    if (!ok) {
      send(mainWindow, 'rdp:status', { state: 'error', machineId: machine.id });
      return { success: false };
    }
    sendRdpCommand(
      machine.id,
      buildConnectCommand({
        host: machine.host,
        port: machine.rdpPort || 3389,
        username: machine.rdpUsername || '',
        password: machine.rdpPassword || '',
      }),
    );
    // "connecting", não "connected": a sidecar hoje só confirma que o
    // processo/pipe subiram, não que o MSTSCLib autenticou (ainda não
    // integrado — ver GOALS.md). Status real de sessão chega numa versão
    // futura, quando a sidecar reportar de volta pelo pipe.
    send(mainWindow, 'rdp:status', {
      state: 'connecting',
      machineId: machine.id,
    });
    return { success: true };
  });

  ipcMain.handle('rdp:resize', (_, { machineId, rect }) => {
    return { success: sendRdpCommand(machineId, buildResizeCommand(rect)) };
  });

  ipcMain.handle('rdp:setVisible', (_, { machineId, visible }) => {
    return {
      success: sendRdpCommand(machineId, buildVisibilityCommand({ visible })),
    };
  });

  ipcMain.handle('rdp:stop', (_, machineId) => {
    sendRdpCommand(machineId, buildDisconnectCommand());
    stopRdpSidecar(machineId);
    send(mainWindow, 'rdp:status', { state: 'disconnected', machineId });
    return { success: true };
  });

  // Provisionamento (GOALS 2, "manual, one-time per machine") — cada
  // chamada abre um prompt de UAC; o usuário aprova (ou não) na hora.
  ipcMain.handle('rdp:enableHosting', async () => {
    try {
      const ok = await enableRdpHosting();
      return { success: ok };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('rdp:createCredential', async (_, { username, password }) => {
    try {
      await createRdpCredential(username, password);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('rdp:generatePassword', () => generatePassword());

  function getLocalTailscaleIp() {
    try {
      const output = execSync('tailscale ip -4', {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
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

  ipcMain.handle('app:notify', (_, { title, body, silent }) => {
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: title || 'OpenPortal',
          body: body || '',
          silent: !!silent,
        });
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
