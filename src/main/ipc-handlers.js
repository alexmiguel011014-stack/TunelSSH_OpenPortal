const { ipcMain, app, dialog } = require('electron');
const { readConfig, writeConfig } = require('./config-manager');
const { connectFileTransfer, disconnectFileTransfer, getActiveConnection } = require('./file-transfer');
const { getFileServerStatus } = require('./file-server');
const { sendConnectRequest, SIGNAL_PORT } = require('./connection-request');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

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
      if (!ip) throw new Error('Endereço IP vazio');
      if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) {
        throw new Error('Endereço IP inválido: use o formato 100.x.x.x');
      }
      const fromName = (opts && opts.fromName) || os.hostname() || 'PC';
      const fromIp = (opts && opts.fromIp) || getLocalTailscaleIp();
      const res = await sendConnectRequest(ip, fromName, fromIp);
      return { success: true, approved: res.approved, message: res.message };
    } catch (err) {
      return { success: false, approved: false, message: err.message };
    }
  });

  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  // Server/Agent status
  ipcMain.handle('server:status', () => {
    return getFileServerStatus();
  });

  ipcMain.handle('server:localIp', () => {
    return { ip: getLocalTailscaleIp() };
  });

  // File transfer handlers
  ipcMain.handle('ft:connect', async (_, host, port) => {
    const targetPort = port || 5001;
    console.log(`[ipc] ft:connect host=${host} port=${targetPort}`);
    try {
      await connectFileTransfer(host, targetPort);
      console.log(`[ipc] ft:connect OK host=${host} port=${targetPort}`);
      send(mainWindow, 'ft:status', { state: 'connected', host });
      return { success: true };
    } catch (err) {
      console.error(`[ipc] ft:connect FAILED host=${host} port=${targetPort}: ${err.message}`);
      send(mainWindow, 'ft:status', { state: 'error', message: err.message });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('ft:disconnect', () => {
    disconnectFileTransfer();
    send(mainWindow, 'ft:status', { state: 'disconnected' });
    return { success: true };
  });

  ipcMain.handle('ft:list', async (_, remotePath) => {
    const p = remotePath || '\\';
    console.log(`[ipc] ft:list path="${p}"`);
    try {
      const conn = getActiveConnection();
      if (!conn) throw new Error('Not connected');
      const result = await conn.listFiles(p);
      console.log(`[ipc] ft:list path="${p}" -> ${result.s === 'ok' ? (result.e || []).length + ' entries' : result.m}`);
      return result;
    } catch (err) {
      console.error(`[ipc] ft:list path="${p}" ERROR: ${err.message}`);
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:download', async (_, remotePath, options) => {
    try {
      const conn = getActiveConnection();
      if (!conn) throw new Error('Not connected');

      const result = await conn.downloadFile(remotePath, (received, total) => {
        send(mainWindow, 'ft:progress', {
          type: 'download',
          path: remotePath,
          received,
          total,
          percent: total > 0 ? Math.round((received / total) * 100) : 0
        });
      });

      if (options && options.savePath) {
        await fsp.writeFile(options.savePath, result.data);
        send(mainWindow, 'ft:progress', {
          type: 'download',
          path: remotePath,
          received: result.size,
          total: result.size,
          percent: 100,
          done: true,
          savePath: options.savePath
        });
        return { s: 'ok', size: result.size, savePath: options.savePath };
      }

      return { s: 'ok', size: result.size, data: result.data };
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:upload', async (_, remotePath, options) => {
    console.log(`[ipc] ft:upload remotePath="${remotePath}"`);
    try {
      const conn = getActiveConnection();
      if (!conn) throw new Error('Not connected');

      let data;
      if (options && options.filePath) {
        data = await fsp.readFile(options.filePath);
      } else if (options && options.data) {
        data = Buffer.from(options.data);
      } else {
        throw new Error('No file data provided');
      }
      console.log(`[ipc] ft:upload remotePath="${remotePath}" size=${data.length} bytes`);

      const result = await conn.uploadFile(remotePath, data, (sent, total) => {
        send(mainWindow, 'ft:progress', {
          type: 'upload',
          path: remotePath,
          sent,
          total,
          percent: total > 0 ? Math.round((sent / total) * 100) : 0
        });
      });
      console.log(`[ipc] ft:upload remotePath="${remotePath}" -> ${result.s === 'ok' ? 'OK' : result.m}`);

      send(mainWindow, 'ft:progress', {
        type: 'upload',
        path: remotePath,
        sent: data.length,
        total: data.length,
        percent: 100,
        done: true
      });

      return result;
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  async function walkDir(dirPath, basePath) {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relPath = path.relative(basePath, fullPath);
      if (entry.isDirectory()) {
        results.push({ path: fullPath, relPath, dir: true });
        const sub = await walkDir(fullPath, basePath);
        results.push(...sub);
      } else if (entry.isFile()) {
        results.push({ path: fullPath, relPath, dir: false });
      }
    }
    return results;
  }

  ipcMain.handle('ft:uploadFolder', async (_, localPath, remoteParent) => {
    try {
      const conn = getActiveConnection();
      if (!conn) return { s: 'err', m: 'Not connected' };

      const files = await walkDir(localPath, localPath);
      const dirs = files.filter(f => f.dir);
      const fileEntries = files.filter(f => !f.dir);

      for (const d of dirs) {
        const remoteDir = remoteParent + '\\' + d.relPath;
        const mkRes = await conn.createDirectory(remoteDir);
        if (mkRes.s !== 'ok' && !(mkRes.m || '').includes('already exists')) {
          console.log(`[ipc] Failed to create dir ${d.relPath}: ${mkRes.m}`);
        }
        send(mainWindow, 'ft:progress', {
          type: 'upload', path: remoteDir, fileName: d.relPath,
          percent: Math.round((dirs.indexOf(d) / (dirs.length + fileEntries.length)) * 50),
          sent: 0, total: 0, done: false
        });
      }

      let uploaded = 0;
      let failed = 0;
      for (const f of fileEntries) {
        const remoteFile = remoteParent + '\\' + f.relPath;
        const data = await fsp.readFile(f.path);
        const upRes = await conn.uploadFile(remoteFile, data, (sent, total) => {
          const baseProgress = 50;
          const fileProgress = (sent / total) * (50 / fileEntries.length);
          const overall = Math.round(baseProgress + fileProgress + (uploaded / fileEntries.length) * 50);
          send(mainWindow, 'ft:progress', {
            type: 'upload', path: remoteFile, fileName: f.relPath,
            percent: Math.min(overall, 99), sent, total, done: false
          });
        });
        if (upRes.s === 'ok') {
          uploaded++;
        } else {
          failed++;
          console.log(`[ipc] Upload failed ${f.relPath}: ${upRes.m}`);
        }
      }

      send(mainWindow, 'ft:progress', {
        type: 'upload', path: remoteParent, percent: 100, done: true
      });

      return { s: 'ok', totalFiles: uploaded, failedFiles: failed };
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:delete', async (_, remotePath) => {
    try {
      const conn = getActiveConnection();
      if (!conn) throw new Error('Not connected');
      return await conn.deleteFile(remotePath);
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:mkdir', async (_, remotePath) => {
    try {
      const conn = getActiveConnection();
      if (!conn) throw new Error('Not connected');
      return await conn.createDirectory(remotePath);
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('dialog:open', async (_, options) => {
    const result = await dialog.showOpenDialog(mainWindow, options || {});
    return result;
  });

  ipcMain.handle('dialog:save', async (_, options) => {
    const result = await dialog.showSaveDialog(mainWindow, options || {});
    return result;
  });

  ipcMain.handle('fs:readFile', async (_, filePath) => {
    const data = await fsp.readFile(filePath);
    return { data: data.toString('base64') };
  });

  ipcMain.handle('fs:stat', async (_, filePath) => {
    const stat = await fsp.stat(filePath);
    return { d: stat.isDirectory(), s: stat.size };
  });

  ipcMain.handle('fs:writeFile', async (_, filePath, base64Data) => {
    const data = Buffer.from(base64Data, 'base64');
    await fsp.writeFile(filePath, data);
    return { success: true };
  });

  function getDrives() {
    if (process.platform === 'win32') {
      const drives = [];
      for (let i = 65; i <= 90; i++) {
        const letter = String.fromCharCode(i);
        const root = letter + ':\\';
        try {
          fs.statSync(root);
          drives.push(root);
        } catch {}
      }
      return drives;
    }
    return ['/'];
  }

  ipcMain.handle('fs:getDrives', async () => {
    return getDrives();
  });

  ipcMain.handle('fs:getHomeDir', () => {
    return process.env.USERPROFILE || process.env.HOME || 'C:\\';
  });

  ipcMain.handle('fs:getSpecialDirs', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\';
    return {
      desktop: home + '\\Desktop',
      downloads: home + '\\Downloads',
      documents: home + '\\Documents',
      home: home
    };
  });

  ipcMain.handle('fs:listDir', async (_, dirPath) => {
    const items = await fsp.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const item of items) {
      try {
        const fullPath = path.join(dirPath, item.name);
        const stat = await fsp.stat(fullPath);
        result.push({
          n: item.name,
          d: item.isDirectory(),
          s: stat.size,
          m: stat.mtime.toISOString()
        });
      } catch {
        result.push({ n: item.name, d: false, s: 0, m: '' });
      }
    }
    result.sort((a, b) => {
      if (a.d !== b.d) return a.d ? -1 : 1;
      return a.n.localeCompare(b.n);
    });
    return result;
  });
}

module.exports = { registerIpcHandlers };
