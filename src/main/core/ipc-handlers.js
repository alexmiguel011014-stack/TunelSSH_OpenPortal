'use strict';

const { ipcMain, app, dialog, Notification } = require('electron');
const { readConfig, writeConfig } = require('../config/config-manager');
const { connectFileTransfer, disconnectFileTransfer, getActiveConnection, setStatusListener } = require('../file-transfer/file-transfer');
const { getFileServerStatus } = require('../file-transfer/file-server');
const { sendConnectRequest, SIGNAL_PORT } = require('../connection/connection-request');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const vpath = require('../file-transfer/vpath');

const PROXY_PORT = 18900;
const FILE_SERVER_PORT = 5001;

function send(mainWindow, channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// --- Caminhos locais (nativos) ----------------------------------------------
// Toda a aritmética de caminho local acontece aqui, com o módulo `path`, e o
// renderer só consome o resultado pronto. É assim que o painel local funciona
// igual em Windows ("C:\Users\x"), Linux ("/home/x") e macOS ("/Users/x") sem
// nenhum separador escrito na mão na UI.

function homeDir() {
  try {
    return app.getPath('home');
  } catch {
    return os.homedir() || process.cwd();
  }
}

function electronPath(name) {
  try {
    const p = app.getPath(name);
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Raízes navegáveis: drives no Windows; "/" mais volumes montados no POSIX.
function listRoots() {
  const roots = [];
  const seen = new Set();
  const push = (p, label) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (seen.has(resolved)) return;
    try {
      if (!fs.statSync(resolved).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(resolved);
    roots.push({ path: process.platform === 'win32' ? resolved + path.sep : resolved, label: label || resolved });
  };

  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const root = letter + ':' + path.sep;
      try {
        fs.statSync(root);
        roots.push({ path: root, label: letter + ':' });
        seen.add(path.resolve(root));
      } catch {}
    }
    return roots;
  }

  push('/', '/');
  // Volumes/mídias montadas: macOS usa /Volumes, Linux /media/<user>, /run/media/<user> e /mnt.
  const mountRoots = process.platform === 'darwin'
    ? ['/Volumes']
    : ['/media/' + (os.userInfo().username || ''), '/run/media/' + (os.userInfo().username || ''), '/media', '/mnt'];
  for (const base of mountRoots) {
    let children;
    try {
      children = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      push(path.join(base, child.name), child.name);
    }
  }
  return roots;
}

// Atalhos resolvidos pelo Electron (respeita pastas localizadas e redirecionadas).
function listQuickAccess() {
  const home = homeDir();
  const items = [{ id: 'home', label: 'Início', path: home }];
  const add = (id, label, electronName, fallbackName) => {
    const p = electronPath(electronName) || path.join(home, fallbackName);
    try {
      if (fs.statSync(p).isDirectory()) items.push({ id, label, path: p });
    } catch {}
  };
  add('desktop', 'Área de Trabalho', 'desktop', 'Desktop');
  add('downloads', 'Downloads', 'downloads', 'Downloads');
  add('documents', 'Documentos', 'documents', 'Documents');
  return items;
}

// Metadados de navegação de um caminho local, prontos para a UI.
function localPathInfo(dirPath) {
  const full = path.resolve(dirPath);
  return {
    path: full,
    parent: vpath.nativeParent(full),
    crumbs: vpath.nativeCrumbs(full),
    sep: path.sep,
    name: path.basename(full) || full,
  };
}

// Resolve um destino local a partir de segmentos, recusando qualquer coisa que
// escape de `localRoot` (proteção contra "../.." vindo do agente remoto).
function resolveDestInsideRoot(localRoot, segs) {
  const rootResolved = path.resolve(localRoot);
  for (const seg of segs) {
    if (!vpath.isSafeName(seg)) {
      throw new Error(`Nome invalido vindo do remoto: ${JSON.stringify(seg)}`);
    }
  }
  const dest = segs.length ? path.resolve(rootResolved, ...segs) : rootResolved;
  const rel = path.relative(rootResolved, dest);
  if (rel && (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep))) {
    throw new Error('Destino fora do diretorio local');
  }
  return dest;
}

function registerIpcHandlers(mainWindow) {
  setStatusListener((evt) => {
    send(mainWindow, 'ft:status', {
      state: evt.state,
      host: evt.host,
      port: evt.port,
      message: evt.message,
      code: evt.code,
      sessionId: evt.sessionId,
    });
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

  // ==========================================================================
  // Transferência de arquivos
  // ==========================================================================

  // Devolve a conexão ativa ou lança um erro com texto amigável para a UI.
  function requireConnection() {
    const conn = getActiveConnection();
    if (!conn || !conn.isAlive()) {
      throw new Error('Sem conexão com o agente remoto');
    }
    return conn;
  }

  ipcMain.handle('ft:connect', async (_, host, port, opts) => {
    const targetPort = port || FILE_SERVER_PORT;
    console.log(`[ipc] ft:connect host=${host} port=${targetPort} force=${!!(opts && opts.force)}`);
    try {
      const conn = await connectFileTransfer(host, targetPort, opts);
      // `info` é opcional: agentes antigos não implementam o comando e o
      // cliente degrada para os valores padrão sem falhar a conexão.
      const info = await conn.getInfo();
      console.log(`[ipc] ft:connect OK host=${host} port=${targetPort} session=${conn.sessionId} proto=${info.proto} platform=${info.platform}`);
      send(mainWindow, 'ft:status', { state: 'connected', host, port: targetPort, sessionId: conn.sessionId });
      return { success: true, sessionId: conn.sessionId, host, port: targetPort, info };
    } catch (err) {
      console.error(`[ipc] ft:connect FAILED host=${host} port=${targetPort}: ${err.message}`);
      // Não emite ft:status aqui: o retorno { success:false, error } é tratado
      // pelo renderer com o guarda de sequência. Falhas pré-handshake rejeitam
      // connect() no file-transfer e são entregues por este retorno; quedas
      // naturais após uma conexão estabelecida seguem pelo status listener.
      return { success: false, error: err.message, host, port: targetPort };
    }
  });

  ipcMain.handle('ft:disconnect', (_, sessionId) => {
    const closed = disconnectFileTransfer(sessionId);
    // Só anuncia desconexão se algo foi realmente encerrado — evita que um
    // pedido obsoleto marque a UI como desconectada enquanto há sessão viva.
    if (closed) {
      send(mainWindow, 'ft:status', { state: 'disconnected', sessionId });
    }
    return { success: true, closed };
  });

  ipcMain.handle('ft:info', async () => {
    try {
      const conn = requireConnection();
      return { s: 'ok', info: await conn.getInfo() };
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:list', async (_, remotePath) => {
    const p = vpath.toVirtual(remotePath);
    try {
      const conn = requireConnection();
      const result = await conn.listFiles(p);
      console.log(`[ipc] ft:list path="${p}" -> ${result.s === 'ok' ? (result.e || []).length + ' entradas' : result.m}`);
      // Normaliza o caminho devolvido: agentes antigos respondem com o caminho
      // nativo em `p`, o que quebraria a navegação do painel remoto.
      return { ...result, p: result.s === 'ok' ? p : undefined };
    } catch (err) {
      console.error(`[ipc] ft:list path="${p}" ERROR: ${err.message}`);
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:stat', async (_, remotePath) => {
    try {
      const conn = requireConnection();
      return await conn.statFile(remotePath);
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:download', async (_, remotePath, options) => {
    const virtual = vpath.toVirtual(remotePath);
    const fileName = vpath.basename(virtual);
    try {
      const conn = requireConnection();

      const opts = options || {};
      // `saveDir` + `saveName` deixam a junção de caminho aqui (com
      // `path.join`), para o renderer nunca escrever separador de diretório.
      let savePath = opts.savePath || null;
      if (!savePath && opts.saveDir && opts.saveName) {
        if (!vpath.isSafeName(opts.saveName)) {
          throw new Error(`Nome de arquivo invalido: ${JSON.stringify(opts.saveName)}`);
        }
        savePath = path.join(opts.saveDir, opts.saveName);
      }
      // Resume: baixa para "<arquivo>.part" e renomeia no fim.
      const partPath = opts.partPath || (opts.resume && savePath ? savePath + '.part' : null);

      let start = 0;
      if (partPath) {
        try {
          const st = await fsp.stat(partPath);
          if (st.isFile()) start = st.size;
        } catch {}
      }

      const writeTarget = partPath || savePath || null;
      if (writeTarget) {
        await fsp.mkdir(path.dirname(writeTarget), { recursive: true });
      }

      const result = await conn.downloadFile(virtual, (received, total) => {
        send(mainWindow, 'ft:progress', {
          type: 'download',
          path: virtual,
          fileName,
          received,
          total,
          percent: total > 0 ? Math.round((received / total) * 100) : 0
        });
      }, { start, filePath: writeTarget });

      if (partPath && savePath && partPath !== savePath) {
        await fsp.mkdir(path.dirname(savePath), { recursive: true });
        try {
          await fsp.rename(partPath, savePath);
        } catch (err) {
          console.error(`[ipc] ft:download finalize rename ERROR: ${err.message}`);
        }
      }

      send(mainWindow, 'ft:progress', {
        type: 'download',
        path: virtual,
        fileName,
        received: result.size,
        total: result.size,
        percent: 100,
        done: true,
        s: 'ok',
        savePath: savePath || partPath || undefined
      });

      return { s: 'ok', size: result.size, savePath: savePath || partPath || null };
    } catch (err) {
      send(mainWindow, 'ft:progress', {
        type: 'download',
        path: virtual,
        fileName,
        received: 0,
        total: 0,
        percent: 0,
        done: true,
        s: 'err',
        error: err.message
      });
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:upload', async (_, remotePath, options) => {
    const virtual = vpath.toVirtual(remotePath);
    const fileName = vpath.basename(virtual);
    console.log(`[ipc] ft:upload remotePath="${virtual}"`);
    try {
      const conn = requireConnection();

      let result;
      if (options && options.filePath) {
        // Upload streaming a partir do disco (evita carregar todo o arquivo
        // em memória via fsp.readFile).
        result = await conn.uploadFileFromPath(virtual, options.filePath, (sent, total) => {
          send(mainWindow, 'ft:progress', {
            type: 'upload', path: virtual, fileName, sent, total,
            percent: total > 0 ? Math.round((sent / total) * 100) : 0
          });
        });
      } else if (options && options.data) {
        const data = Buffer.from(options.data);
        result = await conn.uploadFile(virtual, data, (sent, total) => {
          send(mainWindow, 'ft:progress', {
            type: 'upload', path: virtual, fileName, sent, total,
            percent: total > 0 ? Math.round((sent / total) * 100) : 0
          });
        });
      } else {
        throw new Error('Nenhum arquivo informado para envio');
      }

      if (result.s !== 'ok') throw new Error(result.m || 'Falha no envio');
      console.log(`[ipc] ft:upload remotePath="${virtual}" -> OK`);

      send(mainWindow, 'ft:progress', {
        type: 'upload', path: virtual, fileName,
        sent: result.size || 0, total: result.size || 0,
        percent: 100, done: true, s: 'ok'
      });

      return { s: 'ok', size: result.size || 0, path: virtual };
    } catch (err) {
      // Sem este evento final, a barra de progresso fica presa em "Enviando..."
      // e os botões permanecem desabilitados após uma falha.
      send(mainWindow, 'ft:progress', {
        type: 'upload', path: virtual, fileName,
        sent: 0, total: 0, percent: 0, done: true, s: 'err', error: err.message
      });
      return { s: 'err', m: err.message };
    }
  });

  // Percorre a árvore local devolvendo os segmentos relativos de cada item.
  // Segmentos (array) em vez de string evitam qualquer suposição de separador.
  async function walkDir(dirPath, baseSegs, acc) {
    acc = acc || { dirs: [], files: [] };
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const segs = [...baseSegs, entry.name];
      if (entry.isDirectory()) {
        acc.dirs.push({ path: fullPath, segs });
        await walkDir(fullPath, segs, acc);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(fullPath)).size; } catch {}
        acc.files.push({ path: fullPath, segs, size });
      }
      // Symlinks e nós especiais são ignorados de propósito (evita ciclos).
    }
    return acc;
  }

  ipcMain.handle('ft:uploadFolder', async (_, localPath, remoteParent) => {
    const destRoot = vpath.toVirtual(remoteParent);
    try {
      const conn = requireConnection();

      const { dirs, files } = await walkDir(localPath, [], null);
      const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);

      // Cria a hierarquia pai-filho no remoto antes dos arquivos (inclusive
      // pastas vazias). Raiz primeiro, depois os níveis mais profundos.
      let failedDirs = 0;
      const mkRoot = await conn.createDirectory(destRoot);
      if (mkRoot.s !== 'ok') {
        console.log(`[ipc] ft:uploadFolder mkdir raiz falhou: ${mkRoot.m}`);
      }
      for (const d of [...dirs].sort((a, b) => a.segs.length - b.segs.length)) {
        const remoteDir = vpath.join(destRoot, ...d.segs);
        const mkRes = await conn.createDirectory(remoteDir);
        if (mkRes.s !== 'ok') {
          failedDirs++;
          console.log(`[ipc] ft:uploadFolder mkdir ${d.segs.join('/')} falhou: ${mkRes.m}`);
        }
      }

      let uploaded = 0;
      let failed = 0;
      let bytesDone = 0;
      let lastError = '';
      for (const f of files) {
        const rel = f.segs.join('/');
        const remoteFile = vpath.join(destRoot, ...f.segs);
        try {
          const upRes = await conn.uploadFileFromPath(remoteFile, f.path, (sent) => {
            // Progresso global por bytes: muito mais fiel que contar arquivos.
            const done = bytesDone + sent;
            send(mainWindow, 'ft:progress', {
              type: 'upload', path: remoteFile, fileName: rel,
              sent: done, total: totalBytes,
              percent: totalBytes > 0 ? Math.min(99, Math.round((done / totalBytes) * 100)) : 0,
              done: false
            });
          });
          if (upRes.s === 'ok') {
            uploaded++;
          } else {
            failed++;
            lastError = upRes.m || 'erro';
            console.log(`[ipc] ft:uploadFolder falhou ${rel}: ${lastError}`);
          }
        } catch (err) {
          failed++;
          lastError = err.message;
          console.log(`[ipc] ft:uploadFolder erro ${rel}: ${err.message}`);
        }
        bytesDone += f.size || 0;
      }

      const hadFailure = failed > 0 || failedDirs > 0;
      const s = hadFailure ? (uploaded > 0 ? 'partial' : 'err') : 'ok';
      const errorMsg = s === 'err' ? (lastError || 'Falha ao enviar pasta') : '';

      send(mainWindow, 'ft:progress', {
        type: 'upload', path: destRoot, percent: 100, done: true,
        totalFiles: uploaded, failedFiles: failed, failedDirs, s,
        ...(errorMsg ? { error: errorMsg } : {})
      });

      return {
        s, totalFiles: uploaded, failedFiles: failed, dirs: dirs.length, failedDirs,
        ...(s === 'err' ? { m: errorMsg } : {})
      };
    } catch (err) {
      send(mainWindow, 'ft:progress', {
        type: 'upload', path: destRoot, percent: 0, done: true, s: 'err', error: err.message
      });
      return { s: 'err', m: err.message };
    }
  });

  // Caminha a árvore remota preservando diretórios (inclusive vazios) e
  // arquivos, cada um com os segmentos relativos à raiz da listagem. Falhas ao
  // listar uma subpasta e entradas com nome inválido são acumuladas em
  // acc.failedDirs e não abortam a árvore: os irmãos continuam sendo processados.
  async function listRemoteTree(conn, remotePath, baseSegs, acc) {
    acc = acc || { files: [], directories: [], failedDirs: [] };
    const failDir = (error) => {
      if (!acc.failedDirs.some(f => f.remote === remotePath)) {
        acc.failedDirs.push({ remote: remotePath, segs: baseSegs, error });
      }
    };
    let res;
    try {
      res = await conn.listFiles(remotePath);
    } catch (err) {
      console.log(`[ipc] Falha ao listar ${remotePath}: ${err.message}`);
      failDir(err.message);
      return acc;
    }
    if (res.s !== 'ok') {
      console.log(`[ipc] Falha ao listar ${remotePath}: ${res.m}`);
      failDir(res.m || 'Falha ao listar diretorio remoto');
      return acc;
    }
    for (const entry of res.e || []) {
      const name = String(entry.n || '');
      if (!vpath.isSafeName(name)) {
        console.log(`[ipc] Entrada remota invalida em ${remotePath}: ${JSON.stringify(name)}`);
        failDir(`Nome de entrada invalido no servidor remoto: ${JSON.stringify(name)}`);
        continue;
      }
      const childRemote = vpath.join(remotePath, name);
      const childSegs = [...baseSegs, name];
      if (entry.d) {
        acc.directories.push({ remote: childRemote, segs: childSegs });
        await listRemoteTree(conn, childRemote, childSegs, acc);
      } else {
        acc.files.push({ remote: childRemote, segs: childSegs, size: entry.s || 0 });
      }
    }
    return acc;
  }

  ipcMain.handle('ft:downloadFolder', async (_, remotePath, localRootRaw, options) => {
    const virtualRoot = vpath.toVirtual(remotePath);
    let localRoot = localRootRaw;
    try {
      const conn = requireConnection();

      // Como no download de arquivo: `folderName` é anexado aqui com path.join.
      const folderName = options && options.folderName;
      if (folderName) {
        if (!vpath.isSafeName(folderName)) {
          throw new Error(`Nome de pasta invalido: ${JSON.stringify(folderName)}`);
        }
        localRoot = path.join(localRootRaw, folderName);
      }

      await fsp.mkdir(localRoot, { recursive: true });

      const acc = await listRemoteTree(conn, virtualRoot, [], null);
      const { files, directories } = acc;
      const walkFailedDirs = acc.failedDirs || [];
      const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);

      // Cria todos os diretórios relativos (inclusive vazios) dentro de
      // localRoot antes do download, para a estrutura local espelhar a remota.
      let dirsCreated = 0;
      let failedDirs = walkFailedDirs.length;
      for (const dir of directories) {
        try {
          await fsp.mkdir(resolveDestInsideRoot(localRoot, dir.segs), { recursive: true });
          dirsCreated++;
        } catch (err) {
          failedDirs++;
          console.log(`[ipc] Falha ao criar ${dir.segs.join('/')}: ${err.message}`);
        }
      }

      let downloaded = 0;
      let failedFiles = 0;
      let bytesDone = 0;
      let lastError = walkFailedDirs.length ? walkFailedDirs[0].error : '';
      for (const file of files) {
        const rel = file.segs.join('/');
        try {
          const localFile = resolveDestInsideRoot(localRoot, file.segs);
          // Download direto para o disco (filePath), sem reter o arquivo em
          // memória: cada chunk é gravado conforme chega pelo get.
          await conn.downloadFile(file.remote, (received) => {
            const done = bytesDone + received;
            send(mainWindow, 'ft:progress', {
              type: 'download', path: file.remote, fileName: rel,
              received: done, total: totalBytes,
              percent: totalBytes > 0 ? Math.min(99, Math.round((done / totalBytes) * 100)) : 0,
              done: false
            });
          }, { filePath: localFile });
          downloaded++;
        } catch (err) {
          failedFiles++;
          lastError = err.message;
          console.log(`[ipc] Download falhou ${rel}: ${err.message}`);
        }
        bytesDone += file.size || 0;
      }

      // ok sem falhas; partial com falha mas com processamento; err se nada foi
      // baixado e houve falha (queda total não é tratada como sucesso).
      const hadFailure = failedFiles > 0 || failedDirs > 0;
      const s = hadFailure ? (downloaded > 0 ? 'partial' : 'err') : 'ok';
      const errorMsg = s === 'err' ? (lastError || 'Falha ao baixar pasta') : '';

      send(mainWindow, 'ft:progress', {
        type: 'download', path: virtualRoot, percent: 100, done: true,
        totalFiles: downloaded, failedFiles, dirs: dirsCreated, failedDirs, s,
        ...(errorMsg ? { error: errorMsg } : {})
      });

      return {
        s, totalFiles: downloaded, failedFiles, dirs: dirsCreated, failedDirs, localRoot,
        ...(s === 'err' ? { m: errorMsg } : {})
      };
    } catch (err) {
      // Sem progresso final com done:true, a UI ficaria presa no "Recebendo...".
      send(mainWindow, 'ft:progress', {
        type: 'download', path: virtualRoot, percent: 0, done: true, s: 'err', error: err.message
      });
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:delete', async (_, remotePath) => {
    try {
      const conn = requireConnection();
      return await conn.deleteFile(remotePath);
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  ipcMain.handle('ft:mkdir', async (_, remotePath) => {
    try {
      const conn = requireConnection();
      return await conn.createDirectory(remotePath);
    } catch (err) {
      return { s: 'err', m: err.message };
    }
  });

  // ==========================================================================
  // Diálogos nativos e sistema de arquivos local
  // ==========================================================================

  ipcMain.handle('dialog:open', async (_, options) => {
    return await dialog.showOpenDialog(mainWindow, options || {});
  });

  ipcMain.handle('dialog:save', async (_, options) => {
    return await dialog.showSaveDialog(mainWindow, options || {});
  });

  ipcMain.handle('fs:readFile', async (_, filePath) => {
    const data = await fsp.readFile(filePath);
    return { data: data.toString('base64') };
  });

  ipcMain.handle('fs:stat', async (_, filePath) => {
    try {
      const stat = await fsp.stat(filePath);
      return {
        ok: true,
        s: stat.size,
        d: stat.isDirectory(),
        m: stat.mtime.toISOString(),
        // `n` evita que o renderer tenha que extrair o nome do caminho.
        n: path.basename(filePath),
        p: path.resolve(filePath),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('fs:writeFile', async (_, filePath, base64Data) => {
    const data = Buffer.from(base64Data, 'base64');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, data);
    return { success: true };
  });

  // Junta um caminho local com segmentos validados. Existe para que o renderer
  // nunca precise saber se o separador é "\" ou "/".
  ipcMain.handle('fs:joinPath', (_, base, ...parts) => {
    const segs = parts.flat().filter(p => p !== null && p !== undefined && p !== '');
    for (const seg of segs) {
      if (!vpath.isSafeName(seg)) {
        throw new Error(`Nome invalido para caminho: ${JSON.stringify(seg)}`);
      }
    }
    return segs.length ? path.join(base, ...segs) : path.resolve(base);
  });

  ipcMain.handle('fs:getRoots', () => listRoots());
  ipcMain.handle('fs:getQuickAccess', () => listQuickAccess());
  ipcMain.handle('fs:pathInfo', (_, dirPath) => localPathInfo(dirPath || homeDir()));
  ipcMain.handle('fs:getHomeDir', () => homeDir());

  // Mantidos por compatibilidade com chamadas antigas do renderer.
  ipcMain.handle('fs:getDrives', () => listRoots().map(r => r.path));
  ipcMain.handle('fs:getSpecialDirs', () => {
    const quick = listQuickAccess();
    const byId = Object.fromEntries(quick.map(q => [q.id, q.path]));
    return { home: byId.home, desktop: byId.desktop, downloads: byId.downloads, documents: byId.documents };
  });

  // Lista um diretório local devolvendo já a navegação pronta (pai, migalhas,
  // separador) e o caminho absoluto de cada item — o renderer nunca precisa
  // concatenar caminho, o que elimina a classe de bug de separador entre SOs.
  ipcMain.handle('fs:listDir', async (_, dirPath) => {
    const target = dirPath && String(dirPath).trim() ? dirPath : homeDir();
    let info;
    try {
      info = localPathInfo(target);
    } catch (err) {
      return { ok: false, error: err.message, entries: [] };
    }
    let items;
    try {
      items = await fsp.readdir(info.path, { withFileTypes: true });
    } catch (err) {
      const reason = err.code === 'EPERM' || err.code === 'EACCES'
        ? 'Acesso negado a esta pasta'
        : err.code === 'ENOENT'
          ? 'Pasta não encontrada'
          : err.message;
      return { ...info, ok: false, error: reason, entries: [] };
    }

    const entries = [];
    for (const item of items) {
      const fullPath = path.join(info.path, item.name);
      try {
        const stat = await fsp.stat(fullPath);
        entries.push({
          n: item.name,
          p: fullPath,
          d: stat.isDirectory(),
          s: stat.size,
          m: stat.mtime.toISOString(),
        });
      } catch {
        // Link quebrado ou item sem permissão de stat: lista mesmo assim.
        entries.push({ n: item.name, p: fullPath, d: item.isDirectory(), s: 0, m: '' });
      }
    }
    entries.sort((a, b) => {
      if (a.d !== b.d) return a.d ? -1 : 1;
      return a.n.localeCompare(b.n);
    });
    return { ...info, ok: true, entries };
  });
}

module.exports = { registerIpcHandlers };
