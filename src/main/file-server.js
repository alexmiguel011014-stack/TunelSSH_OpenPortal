const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CHUNK_SIZE = 64 * 1024;
const MSG_JSON = 0;
const MSG_BINARY = 1;
const MSG_BINARY_END = 2;

let serverInstance = null;
let serverPort = 0;
let serverRootDir = '';

function sendJson(socket, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(MSG_JSON, 0);
  header.writeUInt32BE(data.length, 4);
  socket.write(Buffer.concat([header, data]));
}

function sendBinary(socket, chunk) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(MSG_BINARY, 0);
  header.writeUInt32BE(chunk.length, 4);
  socket.write(Buffer.concat([header, chunk]));
}

function sendBinaryEnd(socket) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(MSG_BINARY_END, 0);
  header.writeUInt32BE(0, 4);
  socket.write(header);
}

function resolveSafePath(userPath) {
  if (!userPath || typeof userPath !== 'string') throw new Error('Invalid path');
  const normalized = path.normalize(userPath);
  const rootResolved = path.resolve(serverRootDir);

  let fullPath;
  if (normalized === '.' || normalized === '\\' || normalized === '/') {
    fullPath = rootResolved;
  } else if (path.isAbsolute(normalized)) {
    fullPath = path.resolve(rootResolved, normalized.replace(/^[\\/]+/, ''));
  } else {
    fullPath = path.resolve(rootResolved, normalized);
  }

  if (!fullPath.startsWith(rootResolved + path.sep) && fullPath !== rootResolved) {
    throw new Error('Access denied: path outside root directory');
  }
  return fullPath;
}

async function handleList(socket, msg) {
  try {
    const dirPath = resolveSafePath(msg.p);
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = await fsp.stat(fullPath);
        result.push({ n: entry.name, s: stat.size, d: entry.isDirectory(), m: stat.mtime.toISOString() });
      } catch {
        result.push({ n: entry.name, s: 0, d: entry.isDirectory(), m: '' });
      }
    }
    result.sort((a, b) => {
      if (a.d !== b.d) return a.d ? -1 : 1;
      return a.n.localeCompare(b.n);
    });
    sendJson(socket, { t: 'list_res', i: msg.i, s: 'ok', e: result, p: dirPath });
  } catch (err) {
    sendJson(socket, { t: 'list_res', i: msg.i, s: 'err', m: err.message });
  }
}

async function handleGet(socket, msg) {
  try {
    const filePath = resolveSafePath(msg.p);
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      sendJson(socket, { t: 'get_res', i: msg.i, s: 'err', m: 'Is a directory' });
      return;
    }
    const totalSize = stat.size;
    const offset = Math.min(Math.max(0, parseInt(msg.o, 10) || 0), totalSize);
    sendJson(socket, { t: 'get_res', i: msg.i, s: 'ok', z: totalSize, o: offset, n: path.basename(filePath) });
    const fd = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(CHUNK_SIZE);
      let pos = offset;
      while (pos < totalSize) {
        const { bytesRead } = await fd.read(buffer, 0, CHUNK_SIZE, pos);
        if (bytesRead <= 0) break;
        sendBinary(socket, buffer.slice(0, bytesRead));
        pos += bytesRead;
      }
    } finally {
      await fd.close();
    }
    sendBinaryEnd(socket);
  } catch (err) {
    sendJson(socket, { t: 'get_res', i: msg.i, s: 'err', m: err.message });
  }
}

async function handlePut(socket, msg) {
  let filePath;
  try {
    filePath = resolveSafePath(msg.p);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const fd = await fsp.open(filePath, 'w');
    socket._putState = { filePath, i: msg.i, fd, totalReceived: 0, expectedSize: msg.z || 0, done: false, writeChain: Promise.resolve() };
    sendJson(socket, { t: 'put_res', i: msg.i, s: 'ok' });
  } catch (err) {
    if (socket._putState && socket._putState.fd) {
      try { await socket._putState.fd.close(); } catch {}
    }
    socket._putState = null;
    sendJson(socket, { t: 'put_res', i: msg.i, s: 'err', m: err.message });
  }
}

async function finalizePut(socket) {
  const state = socket._putState;
  if (!state || state.done) return;
  state.done = true;
  try {
    if (state.writeChain) await state.writeChain;
    if (state.fd) { try { await state.fd.close(); } catch {} state.fd = null; }
    sendJson(socket, { t: 'put_done', i: state.i, s: 'ok', p: state.filePath });
  } catch (err) {
    sendJson(socket, { t: 'put_done', i: (state && state.i), s: 'err', m: err.message });
  }
  socket._putState = null;
}

async function handleDelete(socket, msg) {
  try {
    const targetPath = resolveSafePath(msg.p);
    const rootResolved = path.resolve(serverRootDir);
    if (targetPath === rootResolved) {
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
    sendJson(socket, { t: 'mkdir_res', i: msg.i, s: 'ok' });
  } catch (err) {
    sendJson(socket, { t: 'mkdir_res', i: msg.i, s: 'err', m: err.message });
  }
}

class FrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames = [];
    while (this.buffer.length >= 8) {
      const type = this.buffer.readUInt32BE(0);
      const len = this.buffer.readUInt32BE(4);
      const totalLen = 8 + len;
      if (this.buffer.length < totalLen) break;
      const payload = this.buffer.slice(8, totalLen);
      frames.push({ type, payload: type === MSG_JSON ? payload.toString('utf8') : payload });
      this.buffer = this.buffer.slice(totalLen);
    }
    return frames;
  }
}

function handleMessage(socket, msg) {
  switch (msg.t) {
    case 'list': handleList(socket, msg); break;
    case 'get': handleGet(socket, msg); break;
    case 'put': handlePut(socket, msg); break;
    case 'delete': handleDelete(socket, msg); break;
    case 'mkdir': handleMkdir(socket, msg); break;
    default: sendJson(socket, { t: 'error', m: 'Unknown command: ' + msg.t });
  }
}

function startFileServer(port, rootDir) {
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      resolve({ port: serverPort, rootDir: serverRootDir });
      return;
    }

    serverPort = port || 5001;
    serverRootDir = path.resolve(rootDir || process.env.USERPROFILE || process.env.HOME || '.');

    serverInstance = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket._putState = null;

      socket.on('data', async (data) => {
        const frames = decoder.feed(data);
        for (const frame of frames) {
          if (frame.type === MSG_JSON) {
            try {
              const msg = JSON.parse(frame.payload);
              handleMessage(socket, msg);
            } catch (err) {
              sendJson(socket, { t: 'error', m: 'Invalid JSON: ' + err.message });
            }
          } else if (frame.type === MSG_BINARY) {
            if (socket._putState && !socket._putState.done) {
              const st = socket._putState;
              st.totalReceived += frame.payload.length;
              const fd = st.fd;
              st.writeChain = (st.writeChain || Promise.resolve())
                .then(() => fd.write(frame.payload))
                .catch(() => {});
            }
          } else if (frame.type === MSG_BINARY_END) {
            if (socket._putState) finalizePut(socket);
          }
        }
      });

      socket.on('error', () => {});
      socket.on('close', () => {
        if (socket._putState) {
          if (socket._putState.fd) { try { socket._putState.fd.close(); } catch {} }
          socket._putState = null;
        }
      });
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
    serverInstance.close(() => {
      serverInstance = null;
      serverPort = 0;
      serverRootDir = '';
      resolve();
    });
    try { serverInstance.close(); } catch {}
  });
}

function getFileServerStatus() {
  return {
    running: serverInstance !== null,
    port: serverPort,
    rootDir: serverRootDir
  };
}

module.exports = { startFileServer, stopFileServer, getFileServerStatus };
