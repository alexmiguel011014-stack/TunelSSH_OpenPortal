'use strict';

// Agente (PC remoto): servidor TCP na porta 5001 com raiz no diretório do
// usuário. Fala o protocolo binário do OpenPortal (ver docs/FILE_TRANSFER.md).
//
// Todos os caminhos do protocolo são VIRTUAIS (estilo POSIX, relativos à raiz):
// "/", "/Documentos/nota.txt". A conversão para caminho nativo é feita aqui com
// `vpath.toNative`, então o mesmo agente funciona em Windows, Linux e macOS.

const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vpath = require('./vpath');

const CHUNK_SIZE = 64 * 1024;
const MSG_JSON = 0;
const MSG_BINARY = 1;
const MSG_BINARY_END = 2;

// Versão do protocolo anunciada em `info_res`. 1 = separador "\" (legado),
// 2 = caminhos virtuais POSIX + comandos `info`/`stat`.
const PROTOCOL_VERSION = 2;

let serverInstance = null;
let serverPort = 0;
let serverRootDir = '';
let serverQuickDirs = null;

// --- Escrita com backpressure ------------------------------------------------

// Escreve um frame e só resolve quando o kernel aceitou os bytes. Sem isso, um
// download grande para um link lento acumularia o arquivo inteiro no buffer do
// socket (pico de RAM no PC remoto).
function writeFrame(socket, type, payload) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) {
      reject(new Error('Socket fechado'));
      return;
    }
    const body = payload && payload.length ? payload : null;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(type, 0);
    header.writeUInt32BE(body ? body.length : 0, 4);
    const frame = body ? Buffer.concat([header, body]) : header;

    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.removeListener('drain', onDrain);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => finish(null);
    const onClose = () => finish(new Error('Socket fechado durante a escrita'));
    const onError = (err) => finish(err);

    const flushed = socket.write(frame, (err) => {
      if (err) finish(err);
    });
    if (flushed) {
      finish(null);
      return;
    }
    socket.once('drain', onDrain);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

// Envio "fire and forget" para respostas JSON curtas.
function sendJson(socket, obj) {
  writeFrame(socket, MSG_JSON, Buffer.from(JSON.stringify(obj), 'utf8')).catch(() => {});
}

// --- Resolução de caminho ----------------------------------------------------

function resolveSafePath(virtualPath) {
  return vpath.toNative(serverRootDir, virtualPath);
}

// --- Atalhos (Desktop / Downloads / Documentos) ------------------------------

// Nomes possíveis por plataforma. Em Linux as pastas do usuário podem estar
// localizadas ("Área de Trabalho"), então também lemos o XDG user-dirs.
const QUICK_CANDIDATES = {
  desktop: ['Desktop', 'Área de Trabalho', 'Area de Trabalho', 'Escritorio', 'Escritório', 'Bureau', 'Schreibtisch'],
  downloads: ['Downloads', 'Download', 'Descargas', 'Téléchargements', 'Telechargements'],
  documents: ['Documents', 'Documentos', 'Dokumente', 'Documenti'],
};

function readXdgUserDirs(homeDir) {
  const out = {};
  if (process.platform === 'win32' || process.platform === 'darwin') return out;
  try {
    const cfg = fs.readFileSync(path.join(homeDir, '.config', 'user-dirs.dirs'), 'utf8');
    const map = { XDG_DESKTOP_DIR: 'desktop', XDG_DOWNLOAD_DIR: 'downloads', XDG_DOCUMENTS_DIR: 'documents' };
    for (const line of cfg.split('\n')) {
      const m = line.match(/^\s*(XDG_[A-Z]+_DIR)\s*=\s*"(.*)"\s*$/);
      if (!m || !map[m[1]]) continue;
      out[map[m[1]]] = m[2].replace(/^\$HOME/, homeDir);
    }
  } catch {}
  return out;
}

// Descobre os atalhos e devolve caminhos VIRTUAIS (relativos à raiz do agente).
// Só inclui o que existir de fato e estiver dentro da raiz.
function detectQuickDirs(rootDir, overrides) {
  const result = {};
  const rootResolved = path.resolve(rootDir);
  const xdg = readXdgUserDirs(rootResolved);

  const consider = (key, nativePath) => {
    if (!nativePath || result[key]) return;
    let stat;
    try {
      stat = fs.statSync(nativePath);
    } catch {
      return;
    }
    if (!stat.isDirectory()) return;
    const rel = path.relative(rootResolved, path.resolve(nativePath));
    if (rel && (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep))) return;
    result[key] = vpath.fromNative(rootResolved, nativePath);
  };

  for (const key of Object.keys(QUICK_CANDIDATES)) {
    if (overrides && overrides[key]) consider(key, overrides[key]);
    if (xdg[key]) consider(key, xdg[key]);
    for (const name of QUICK_CANDIDATES[key]) {
      consider(key, path.join(rootResolved, name));
    }
  }
  return result;
}

// --- Handlers ----------------------------------------------------------------

async function handleInfo(socket, msg) {
  try {
    sendJson(socket, {
      t: 'info_res',
      i: msg.i,
      s: 'ok',
      proto: PROTOCOL_VERSION,
      platform: process.platform,
      sep: path.sep,
      host: os.hostname(),
      root: serverRootDir,
      quick: serverQuickDirs || {},
    });
  } catch (err) {
    sendJson(socket, { t: 'info_res', i: msg.i, s: 'err', m: err.message });
  }
}

async function handleList(socket, msg) {
  try {
    const dirPath = resolveSafePath(msg.p);
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const isDir = entry.isDirectory();
      try {
        const stat = await fsp.stat(path.join(dirPath, entry.name));
        result.push({ n: entry.name, s: stat.size, d: stat.isDirectory(), m: stat.mtime.toISOString() });
      } catch {
        // Link quebrado, permissão negada ou arquivo removido durante a
        // listagem: entra sem metadados em vez de derrubar o diretório inteiro.
        result.push({ n: entry.name, s: 0, d: isDir, m: '' });
      }
    }
    result.sort((a, b) => {
      if (a.d !== b.d) return a.d ? -1 : 1;
      return a.n.localeCompare(b.n);
    });
    sendJson(socket, {
      t: 'list_res',
      i: msg.i,
      s: 'ok',
      e: result,
      p: vpath.fromNative(serverRootDir, dirPath),
      np: dirPath,
    });
  } catch (err) {
    sendJson(socket, { t: 'list_res', i: msg.i, s: 'err', m: err.message });
  }
}

async function handleStat(socket, msg) {
  try {
    const target = resolveSafePath(msg.p);
    const stat = await fsp.stat(target);
    sendJson(socket, {
      t: 'stat_res',
      i: msg.i,
      s: 'ok',
      d: stat.isDirectory(),
      z: stat.size,
      m: stat.mtime.toISOString(),
      p: vpath.fromNative(serverRootDir, target),
    });
  } catch (err) {
    sendJson(socket, { t: 'stat_res', i: msg.i, s: 'err', m: err.message });
  }
}

// Envia um arquivo em chunks. Serializado por socket (ver `enqueueGet`) para
// que dois `get` simultâneos não intercalem frames binários.
async function handleGet(socket, msg) {
  let fd = null;
  try {
    const filePath = resolveSafePath(msg.p);
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      sendJson(socket, { t: 'get_res', i: msg.i, s: 'err', m: 'Is a directory' });
      return;
    }
    const totalSize = stat.size;
    const offset = Math.min(Math.max(0, parseInt(msg.o, 10) || 0), totalSize);

    await writeFrame(socket, MSG_JSON, Buffer.from(JSON.stringify({
      t: 'get_res', i: msg.i, s: 'ok', z: totalSize, o: offset, n: path.basename(filePath),
    }), 'utf8'));

    fd = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let pos = offset;
    while (pos < totalSize) {
      if (socket.destroyed) throw new Error('Socket fechado durante o envio');
      const { bytesRead } = await fd.read(buffer, 0, CHUNK_SIZE, pos);
      if (bytesRead <= 0) break;
      await writeFrame(socket, MSG_BINARY, buffer.subarray(0, bytesRead));
      pos += bytesRead;
    }
    await writeFrame(socket, MSG_BINARY_END, null);
  } catch (err) {
    sendJson(socket, { t: 'get_res', i: msg.i, s: 'err', m: err.message });
  } finally {
    if (fd) { try { await fd.close(); } catch {} }
  }
}

// Recebe um arquivo. A promise só resolve no `BINARY_END` (ou na queda do
// socket), então a fila de `put` impede que dois uploads concorrentes
// disputem `socket._putState`.
function handlePut(socket, msg) {
  return new Promise((resolve) => {
    (async () => {
      try {
        const filePath = resolveSafePath(msg.p);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        const fd = await fsp.open(filePath, 'w');
        socket._putState = {
          filePath,
          i: msg.i,
          fd,
          totalReceived: 0,
          expectedSize: msg.z || 0,
          done: false,
          writeError: null,
          writeChain: Promise.resolve(),
          settle: resolve,
        };
        sendJson(socket, { t: 'put_res', i: msg.i, s: 'ok' });
      } catch (err) {
        if (socket._putState && socket._putState.fd) {
          try { await socket._putState.fd.close(); } catch {}
        }
        socket._putState = null;
        sendJson(socket, { t: 'put_res', i: msg.i, s: 'err', m: err.message });
        resolve();
      }
    })();
  });
}

async function finalizePut(socket) {
  const state = socket._putState;
  if (!state || state.done) return;
  state.done = true;
  socket._putState = null;
  try {
    if (state.writeChain) await state.writeChain;
    if (state.fd) { try { await state.fd.close(); } catch {} state.fd = null; }
    if (state.writeError) throw state.writeError;
    if (state.expectedSize > 0 && state.totalReceived !== state.expectedSize) {
      throw new Error(`Tamanho incompleto: recebidos ${state.totalReceived} de ${state.expectedSize} bytes`);
    }
    sendJson(socket, {
      t: 'put_done',
      i: state.i,
      s: 'ok',
      z: state.totalReceived,
      p: vpath.fromNative(serverRootDir, state.filePath),
    });
  } catch (err) {
    // Arquivo parcial não deve ficar no disco fingindo estar completo.
    try { await fsp.rm(state.filePath, { force: true }); } catch {}
    sendJson(socket, { t: 'put_done', i: state.i, s: 'err', m: err.message });
  } finally {
    if (typeof state.settle === 'function') state.settle();
  }
}

// Queda de conexão no meio de um upload: fecha o fd, remove o parcial e
// libera a fila.
async function abortPut(socket) {
  const state = socket._putState;
  if (!state || state.done) return;
  state.done = true;
  socket._putState = null;
  try { if (state.writeChain) await state.writeChain; } catch {}
  if (state.fd) { try { await state.fd.close(); } catch {} state.fd = null; }
  try { await fsp.rm(state.filePath, { force: true }); } catch {}
  if (typeof state.settle === 'function') state.settle();
}

async function handleDelete(socket, msg) {
  try {
    const targetPath = resolveSafePath(msg.p);
    if (targetPath === path.resolve(serverRootDir)) {
      sendJson(socket, { t: 'delete_res', i: msg.i, s: 'err', m: 'Cannot delete root directory' });
      return;
    }
    await fsp.rm(targetPath, { recursive: true, force: true });
    sendJson(socket, { t: 'delete_res', i: msg.i, s: 'ok' });
  } catch (err) {
    sendJson(socket, { t: 'delete_res', i: msg.i, s: 'err', m: err.message });
  }
}

async function handleMkdir(socket, msg) {
  try {
    const targetPath = resolveSafePath(msg.p);
    await fsp.mkdir(targetPath, { recursive: true });
    sendJson(socket, {
      t: 'mkdir_res',
      i: msg.i,
      s: 'ok',
      p: vpath.fromNative(serverRootDir, targetPath),
    });
  } catch (err) {
    sendJson(socket, { t: 'mkdir_res', i: msg.i, s: 'err', m: err.message });
  }
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  feed(data) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    const frames = [];
    while (this.buffer.length >= 8) {
      const type = this.buffer.readUInt32BE(0);
      const len = this.buffer.readUInt32BE(4);
      const totalLen = 8 + len;
      if (this.buffer.length < totalLen) break;
      const payload = this.buffer.subarray(8, totalLen);
      frames.push({ type, payload: type === MSG_JSON ? payload.toString('utf8') : Buffer.from(payload) });
      this.buffer = this.buffer.subarray(totalLen);
    }
    return frames;
  }
}

// Duas filas por socket: `get` ocupa o canal binário servidor->cliente e `put`
// o canal cliente->servidor. Como são direções distintas, podem correr em
// paralelo entre si, mas nunca contra outro do mesmo tipo.
function enqueue(socket, key, fn) {
  const prev = socket[key] || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  socket[key] = next;
  return next;
}

function handleMessage(socket, msg) {
  switch (msg.t) {
    case 'info': handleInfo(socket, msg); break;
    case 'list': handleList(socket, msg); break;
    case 'stat': handleStat(socket, msg); break;
    case 'get': enqueue(socket, '_getQueue', () => handleGet(socket, msg)); break;
    case 'put': enqueue(socket, '_putQueue', () => handlePut(socket, msg)); break;
    case 'delete': handleDelete(socket, msg); break;
    case 'mkdir': handleMkdir(socket, msg); break;
    // Resposta de comando desconhecido ecoa `i` para que clientes novos
    // resolvam a pendência na hora em vez de esperar o timeout.
    default: sendJson(socket, { t: 'error', i: msg.i, s: 'err', m: 'Unknown command: ' + msg.t });
  }
}

function startFileServer(port, rootDir, options) {
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      resolve({ port: serverPort, rootDir: serverRootDir });
      return;
    }

    serverPort = port || 5001;
    serverRootDir = path.resolve(rootDir || os.homedir() || process.cwd());
    serverQuickDirs = detectQuickDirs(serverRootDir, options && options.quickDirs);

    serverInstance = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.setNoDelay(true);
      socket._putState = null;
      socket._getQueue = Promise.resolve();
      socket._putQueue = Promise.resolve();

      socket.on('data', (data) => {
        let frames;
        try {
          frames = decoder.feed(data);
        } catch (err) {
          sendJson(socket, { t: 'error', m: 'Frame invalido: ' + err.message });
          socket.destroy();
          return;
        }
        for (const frame of frames) {
          if (frame.type === MSG_JSON) {
            let msg;
            try {
              msg = JSON.parse(frame.payload);
            } catch (err) {
              sendJson(socket, { t: 'error', m: 'Invalid JSON: ' + err.message });
              continue;
            }
            handleMessage(socket, msg);
          } else if (frame.type === MSG_BINARY) {
            const st = socket._putState;
            if (st && !st.done) {
              st.totalReceived += frame.payload.length;
              const fd = st.fd;
              st.writeChain = st.writeChain
                .then(() => fd.write(frame.payload))
                .catch((err) => { if (!st.writeError) st.writeError = err; });
            }
          } else if (frame.type === MSG_BINARY_END) {
            if (socket._putState) finalizePut(socket);
          }
        }
      });

      socket.on('error', () => {});
      socket.on('close', () => { abortPut(socket); });
    });

    serverInstance.on('error', (err) => {
      serverInstance = null;
      reject(err);
    });

    serverInstance.listen(serverPort, '0.0.0.0', () => {
      resolve({ port: serverPort, rootDir: serverRootDir });
    });
  });
}

function stopFileServer() {
  return new Promise((resolve) => {
    if (!serverInstance) { resolve(); return; }
    const inst = serverInstance;
    serverInstance = null;
    serverPort = 0;
    serverRootDir = '';
    serverQuickDirs = null;
    inst.close(() => resolve());
  });
}

function getFileServerStatus() {
  return {
    running: serverInstance !== null,
    port: serverPort,
    rootDir: serverRootDir,
    platform: process.platform,
    proto: PROTOCOL_VERSION,
  };
}

module.exports = { startFileServer, stopFileServer, getFileServerStatus, PROTOCOL_VERSION };
