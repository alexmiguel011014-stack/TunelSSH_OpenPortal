const { ipcMain, app, dialog, Notification } = require('electron');
const { readConfig, writeConfig } = require('./config-manager');
const { connectFileTransfer, disconnectFileTransfer, getActiveConnection, setStatusListener } = require('./file-transfer');
const { getFileServerStatus } = require('./file-server');
const { sendConnectRequest, SIGNAL_PORT } = require('./connection-request');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');

const PROXY_PORT = 18900;

function send(mainWindow, channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function registerIpcHandlers(mainWindow) {
  setStatusListener((evt) => {
    send(mainWindow, 'ft:status', { state: evt.state, host: evt.host, message: evt.message, code: evt.code });
  });

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
      // Não emite ft:status aqui: o retorno { success:false, error } é tratado
      // pelo renderer com connectSeq. Falhas pré-handshake rejeitam connect()
      // no file-transfer e são entregues por este retorno; quedas naturais
      // após uma conexão estabelecida seguem pelo status listener.
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

      const savePath = options && options.savePath;
      const partPath = options && options.partPath;

      let start = 0;
      if (partPath) {
        try {
          const st = await fsp.stat(partPath);
          if (st.isFile()) start = st.size;
        } catch {}
      }

      const writeTarget = partPath || savePath || null;
      const result = await conn.downloadFile(remotePath, (received, total) => {
        send(mainWindow, 'ft:progress', {
          type: 'download',
          path: remotePath,
          received,
          total,
          percent: total > 0 ? Math.round((received / total) * 100) : 0
        });
      }, { start, filePath: writeTarget });

      if (partPath && savePath) {
        try {
          await fsp.mkdir(path.dirname(savePath), { recursive: true });
          await fsp.rename(partPath, savePath);
        } catch (err) {
          console.error(`[ipc] ft:download finalize rename ERROR: ${err.message}`);
        }
        send(mainWindow, 'ft:progress', {
          type: 'download',
          path: remotePath,
          received: result.size,
          total: result.size,
          percent: 100,
          done: true,
          savePath
        });
        return { s: 'ok', size: result.size, savePath };
      }

      if (savePath) {
        await fsp.mkdir(path.dirname(savePath), { recursive: true });
        await fsp.writeFile(savePath, result.data);
        send(mainWindow, 'ft:progress', {
          type: 'download',
          path: remotePath,
          received: result.size,
          total: result.size,
          percent: 100,
          done: true,
          savePath
        });
        return { s: 'ok', size: result.size, savePath };
      }

      return { s: 'ok', size: result.size };
    } catch (err) {
      send(mainWindow, 'ft:progress', {
        type: 'download',
        path: remotePath,
        received: 0,
        total: 0,
        percent: 0,
        done: true,
        error: err.message
      });
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

  // Caminha a árvore remota preservando diretórios (inclusive vazios) e
  // arquivos, cada um com o caminho relativo à raiz da listagem. Falhas ao
  // listar uma subpasta (listFiles rejeitado ou s:'err') e entradas com nome
  // inválido são acumuladas em acc.failedDirs e não abortam a árvore: os
  // irmãos continuam sendo processados.
  async function listRemoteTree(conn, remotePath, relBase, acc) {
    acc = acc || { files: [], directories: [], failedDirs: [] };
    function failDir(rel, error) {
      if (!acc.failedDirs.some(f => f.remote === remotePath)) {
        acc.failedDirs.push({ remote: remotePath, rel, error });
      }
    }
    let res;
    try {
      res = await conn.listFiles(remotePath);
    } catch (err) {
      console.log(`[ipc] Failed to list dir ${remotePath}: ${err.message}`);
      failDir(relBase || '', err.message);
      return acc;
    }
    if (res.s !== 'ok') {
      console.log(`[ipc] Failed to list dir ${remotePath}: ${res.m}`);
      failDir(relBase || '', res.m || 'Falha ao listar diretorio remoto');
      return acc;
    }
    for (const entry of res.e || []) {
      const name = String(entry.n || '');
      if (!name || name === '.' || name === '..' || name.includes('\\') || name.includes('/') || name.includes(':')) {
        console.log(`[ipc] Invalid remote entry name in ${remotePath}: ${JSON.stringify(name)}`);
        failDir(relBase || '', `Nome de entrada invalido no servidor remoto: ${JSON.stringify(name)}`);
        continue;
      }
      const childRemote = (remotePath.endsWith('\\') ? remotePath : remotePath + '\\') + name;
      const childRel = relBase ? relBase + '\\' + name : name;
      if (entry.d) {
        acc.directories.push({ remote: childRemote, rel: childRel });
        await listRemoteTree(conn, childRemote, childRel, acc);
      } else {
        acc.files.push({ remote: childRemote, rel: childRel });
      }
    }
    return acc;
  }

  // Aceita o próprio root e filhos; rejeita traversal (../.. ou caminho
  // absoluto) usando path.relative, que funciona mesmo quando localRoot
  // é uma raiz de drive como C:\.
  function resolveDestInsideRoot(localRoot, relPath) {
    const rootResolved = path.resolve(localRoot);
    const dest = path.resolve(rootResolved, ...relPath.split('\\'));
    const rel = path.relative(rootResolved, dest);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
      throw new Error('Destino fora do diretorio local');
    }
    return dest;
  }

  ipcMain.handle('ft:downloadFolder', async (_, remotePath, localRoot) => {
    try {
      const conn = getActiveConnection();
      if (!conn) return { s: 'err', m: 'Not connected' };

      await fsp.mkdir(localRoot, { recursive: true });

      const acc = await listRemoteTree(conn, remotePath || '\\');
      const { files, directories } = acc;
      const walkFailedDirs = acc.failedDirs || [];

      // Cria todos os diretórios relativos (inclusive vazios) dentro de
      // localRoot antes do download, para a estrutura local espelhar a remota.
      // Falhas locais (ex.: colisão com arquivo existente) são contabilizadas
      // em failedDirs e não abortam a árvore inteira.
      let dirsCreated = 0;
      let failedDirs = 0;
      for (const dir of directories) {
        try {
          const localDir = resolveDestInsideRoot(localRoot, dir.rel);
          await fsp.mkdir(localDir, { recursive: true });
          dirsCreated++;
        } catch (err) {
          failedDirs++;
          console.log(`[ipc] Failed to create dir ${dir.rel}: ${err.message}`);
        }
        send(mainWindow, 'ft:progress', {
          type: 'download', path: dir.remote, fileName: dir.rel, done: false
        });
      }
      // Integra as falhas de listagem da caminhada ao contador de diretórios.
      failedDirs += walkFailedDirs.length;

      let downloaded = 0;
      let failedFiles = 0;
      for (const file of files) {
        try {
          const localFile = resolveDestInsideRoot(localRoot, file.rel);
          const result = await conn.downloadFile(file.remote, (received, total) => {
            send(mainWindow, 'ft:progress', {
              type: 'download', path: file.remote, fileName: file.rel,
              received, total, percent: total > 0 ? Math.round((received / total) * 100) : 0
            });
          });
          await fsp.mkdir(path.dirname(localFile), { recursive: true });
          await fsp.writeFile(localFile, result.data);
          send(mainWindow, 'ft:progress', {
            type: 'download', path: file.remote, fileName: file.rel,
            received: result.size, total: result.size, percent: 100, done: false
          });
          downloaded++;
        } catch (err) {
          failedFiles++;
          console.log(`[ipc] Download failed ${file.rel}: ${err.message}`);
        }
      }

      // Diferencia o resultado: ok sem falhas; partial com falha mas com
      // processamento; err se nada foi baixado e houve falha (queda total não
      // é tratada como sucesso).
      const hadFailure = failedFiles > 0 || failedDirs > 0;
      const s = hadFailure ? (downloaded > 0 ? 'partial' : 'err') : 'ok';

      // Para s:'err' o evento final carrega a mensagem de erro para a UI não
      // tratar como sucesso silencioso.
      const errorMsg = s === 'err'
        ? (walkFailedDirs[0] && walkFailedDirs[0].error) || 'Falha ao baixar pasta'
        : '';

      send(mainWindow, 'ft:progress', {
        type: 'download', path: remotePath, percent: 100, done: true,
        totalFiles: downloaded, failedFiles, dirs: dirsCreated, failedDirs, s,
        ...(errorMsg ? { error: errorMsg } : {})
      });

      return {
        s, totalFiles: downloaded, failedFiles, dirs: dirsCreated, failedDirs,
        ...(s === 'err' ? { m: errorMsg } : {})
      };
    } catch (err) {
      // Sem progresso final com done:true, a UI ficaria presa no "Recebendo...".
      send(mainWindow, 'ft:progress', {
        type: 'download', path: remotePath, percent: 0, done: true, error: err.message
      });
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
