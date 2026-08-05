const WebSocket = require('ws');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CHUNK_SIZE = 64 * 1024;
const MSG_JSON = 0;
const MSG_BINARY = 1;
const MSG_BINARY_END = 2;

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
      frames.push({ type, payload });
      this.buffer = this.buffer.slice(totalLen);
    }
    return frames;
  }
}

class FileTransferConnection {
  constructor() {
    this.ws = null;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
    this.pendingUploads = new Map();
    this.idCounter = 0;
    this.connected = false;
    this._resolveConnect = null;
    this._rejectConnect = null;
    this.currentGet = null;
    this._activeGetId = null;
    this._onStatus = null;
    this._host = '';
    this._port = 0;
  }

  connect(proxyUrl) {
    return new Promise((resolve, reject) => {
      this._resolveConnect = resolve;
      this._rejectConnect = reject;
      this._connectTimeout = setTimeout(() => {
        this._failConnect(new Error('Connection timeout'));
      }, 15000);

      this.ws = new WebSocket(proxyUrl);
      this.ws.binaryType = 'nodebuffer';

      this.ws.on('open', () => {
        this.connected = true;
      });

      this.ws.on('message', (data) => {
        const buf = Buffer.from(data);
        const frames = this.decoder.feed(buf);
        for (const frame of frames) {
          this._handleFrame(frame);
        }
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = (reason && reason.toString()) || 'Connection closed';
        this.connected = false;
        this._rejectPending(reasonStr);
        this._failConnect(new Error(reasonStr));
        this._notifyStatus('disconnected', reasonStr, code);
      });

      this.ws.on('error', (err) => {
        this.connected = false;
        this._rejectPending(err.message);
        this._failConnect(err);
        this._notifyStatus('error', err.message);
      });
    });
  }

  _failConnect(err) {
    clearTimeout(this._connectTimeout);
    if (this._rejectConnect) {
      this._rejectConnect(err);
      this._resolveConnect = null;
      this._rejectConnect = null;
    }
  }

  _ackConnect(msg) {
    clearTimeout(this._connectTimeout);
    if (!this._resolveConnect) return;
    if (msg.s === 'ok') {
      this.connected = true;
      this._resolveConnect();
    } else {
      this.connected = false;
      this._rejectConnect(new Error(msg.m || 'Remote connection failed'));
    }
    this._resolveConnect = null;
    this._rejectConnect = null;
  }

  disconnect() {
    this._failConnect(new Error('Disconnected'));
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this._rejectPending('Disconnected');
    this._notifyStatus('disconnected', 'Disconnected by client');
  }

  setStatusListener(cb) {
    this._onStatus = typeof cb === 'function' ? cb : null;
  }

  _notifyStatus(state, message, code) {
    if (this._onStatus) {
      try { this._onStatus({ state, message, host: this._host, port: this._port, code }); } catch {}
    }
  }

  _sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(MSG_JSON, 0);
    header.writeUInt32BE(data.length, 4);
    this.ws.send(Buffer.concat([header, data]));
  }

  _sendBinary(chunk) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(MSG_BINARY, 0);
    header.writeUInt32BE(chunk.length, 4);
    this.ws.send(Buffer.concat([header, chunk]));
  }

  _sendBinaryEnd() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(MSG_BINARY_END, 0);
    header.writeUInt32BE(0, 4);
    this.ws.send(header);
  }

  _rejectPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry._timeout);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    for (const [id, entry] of this.pendingUploads) {
      clearTimeout(entry._timeout);
      entry.reject(new Error(reason));
    }
    this.pendingUploads.clear();
    this.currentGet = null;
    this._activeGetId = null;
  }

  _handleFrame(frame) {
    if (frame.type === MSG_JSON) {
      const msg = JSON.parse(frame.payload.toString('utf8'));

      if (msg.t === 'tcp') {
        this._ackConnect(msg);
        return;
      }

      if (msg.t === 'get_res' && msg.s === 'ok') {
        const entry = this.pending.get(msg.i);
        if (entry && entry.kind === 'get') {
          entry.totalSize = msg.z;
          entry.basename = msg.n;
        } else if (this.currentGet) {
          this.currentGet.totalSize = msg.z;
          this.currentGet.basename = msg.n;
        }
        return;
      }

      if (msg.t === 'get_done' || (msg.t === 'get_res' && msg.s !== 'ok')) {
        let entry = this.pending.get(msg.i);
        if (!entry) entry = this.currentGet;
        if (entry && entry._callback) {
          entry._callback(msg);
        }
        return;
      }

      if (msg.t === 'put_res' && msg.s === 'ok') {
        const entry = this.pendingUploads.get(msg.i);
        if (entry) {
          entry.ack = true;
          if (typeof entry.onAck === 'function') {
            try { entry.onAck(); } catch {}
          }
        }
        return;
      }

      if (msg.t === 'put_done') {
        const entry = this.pendingUploads.get(msg.i);
        if (entry) {
          this.pendingUploads.delete(msg.i);
          entry.resolve(msg);
        }
        return;
      }

      if (msg.t === 'put_res' && msg.s !== 'ok') {
        const entry = this.pendingUploads.get(msg.i);
        if (entry) {
          this.pendingUploads.delete(msg.i);
          entry.reject(new Error(msg.m || 'Upload failed'));
        }
        return;
      }

      const entry = this.pending.get(msg.i);
      if (entry) {
        this.pending.delete(msg.i);
        if (entry._timeout) clearTimeout(entry._timeout);
        if (entry._callback) {
          entry._callback(msg);
        } else if (entry.resolve) {
          entry.resolve(msg);
        }
      }
      return;
    }

    if (frame.type === MSG_BINARY) {
      // Associa o chunk ao get ativo; tenta pelo id atual, depois currentGet
      let target = null;
      if (this._activeGetId != null) target = this.pending.get(this._activeGetId);
      if (!target) target = this.currentGet;
      if (target && !target.done) {
        target.chunks.push(frame.payload);
        target.receivedSize += frame.payload.length;
        if (target._onProgress) {
          target._onProgress(target.receivedSize, target.totalSize);
        }
      } else {
        console.warn('[file-transfer] MSG_BINARY orphan: dropping chunk');
      }
      return;
    }

    if (frame.type === MSG_BINARY_END) {
      let target = null;
      if (this._activeGetId != null) target = this.pending.get(this._activeGetId);
      if (!target) target = this.currentGet;
      if (target && !target.done) {
        target._callback({ s: 'ok', data: Buffer.concat(target.chunks), size: target.totalSize });
      } else {
        console.warn('[file-transfer] MSG_BINARY_END orphan: no active get');
      }
      return;
    }
  }

  async listFiles(remotePath) {
    const id = ++this.idCounter;
    console.log(`[file-transfer] listFiles: path="${remotePath}", id=${id}`);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, _timeout: null };
      entry._timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout aguardando list_res (id=${id})`));
      }, 30000);
      this.pending.set(id, entry);
      try {
        this._sendJson({ t: 'list', p: remotePath, i: id });
      } catch (err) {
        clearTimeout(entry._timeout);
        this.pending.delete(id);
        console.error(`[file-transfer] listFiles ERROR for path="${remotePath}": ${err.message}`);
        reject(err);
      }
    });
  }

  async downloadFile(remotePath, onProgress) {
    const id = ++this.idCounter;
    console.log(`[file-transfer] downloadFile: path="${remotePath}", id=${id}`);
    return new Promise((resolve, reject) => {
      const state = {
        kind: 'get',
        chunks: [],
        totalSize: 0,
        receivedSize: 0,
        basename: '',
        done: false,
        _onProgress: onProgress
      };
      const finish = (err, data, size) => {
        if (state.done) return;
        state.done = true;
        clearTimeout(state._timeout);
        if (this._activeGetId === id) this._activeGetId = null;
        if (this.currentGet === state) this.currentGet = null;
        this.pending.delete(id);
        if (err) {
          console.error(`[file-transfer] downloadFile ERROR id=${id}: ${err.message}`);
          reject(err);
        } else {
          console.log(`[file-transfer] downloadFile OK id=${id}: ${data.length} bytes (expected ${size})`);
          resolve({ data, size: size || data.length });
        }
      };
      state._callback = (msg) => {
        if (msg.s === 'err') {
          finish(new Error(msg.m || 'Download failed'));
          return;
        }
        if (msg.s === 'ok' && msg.data) {
          finish(null, msg.data, msg.size);
          return;
        }
        if (msg.s === 'ok') {
          finish(null, Buffer.concat(state.chunks), state.totalSize);
        }
      };
      state._timeout = setTimeout(() => {
        finish(new Error(`Timeout aguardando get_res (id=${id})`));
      }, 30000);

      this.pending.set(id, state);
      this._activeGetId = id;
      this.currentGet = state;
      try {
        this._sendJson({ t: 'get', p: remotePath, i: id });
      } catch (err) {
        finish(err);
      }
    });
  }

  async uploadFile(remotePath, data, onProgress) {
    const id = ++this.idCounter;
    const totalSize = data.length;
    console.log(`[file-transfer] uploadFile: path="${remotePath}", size=${totalSize} bytes`);

    return new Promise((resolve, reject) => {
      let offset = 0;
      const sendChunks = () => {
        if (offset >= totalSize) {
          this._sendBinaryEnd();
          return;
        }
        const chunk = data.slice(offset, offset + CHUNK_SIZE);
        try {
          this._sendBinary(chunk);
        } catch (err) {
          this.pendingUploads.delete(id);
          reject(err);
          return;
        }
        offset += chunk.length;
        if (onProgress) onProgress(offset, totalSize);
        setImmediate(sendChunks);
      };

      const ackTimeout = setTimeout(() => {
        if (!entry || !entry.ack) {
          this.pendingUploads.delete(id);
          reject(new Error('Timeout aguardando put_res do servidor remoto'));
        }
      }, 20000);

      const entry = {
        resolve: (msg) => { clearTimeout(ackTimeout); resolve(msg); },
        reject: (err) => { clearTimeout(ackTimeout); reject(err); },
        ack: false,
        onAck: () => {
          setImmediate(sendChunks);
        }
      };
      this.pendingUploads.set(id, entry);

      try {
        this._sendJson({ t: 'put', p: remotePath, z: totalSize, i: id });
      } catch (err) {
        clearTimeout(ackTimeout);
        this.pendingUploads.delete(id);
        console.error(`[file-transfer] uploadFile ERROR for path="${remotePath}": ${err.message}`);
        reject(err);
      }
    });
  }

  async deleteFile(remotePath) {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, _timeout: null };
      entry._timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout aguardando delete_res (id=${id})`));
      }, 30000);
      this.pending.set(id, entry);
      try {
        this._sendJson({ t: 'delete', p: remotePath, i: id });
      } catch (err) {
        clearTimeout(entry._timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async createDirectory(remotePath) {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, _timeout: null };
      entry._timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout aguardando mkdir_res (id=${id})`));
      }, 30000);
      this.pending.set(id, entry);
      try {
        this._sendJson({ t: 'mkdir', p: remotePath, i: id });
      } catch (err) {
        clearTimeout(entry._timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}

let activeConnection = null;
let activeStatusListener = null;

async function connectFileTransfer(host, port) {
  if (activeConnection) {
    activeConnection.disconnect();
  }
  const conn = new FileTransferConnection();
  conn._host = host;
  conn._port = port || 5001;
  if (activeStatusListener) conn.setStatusListener(activeStatusListener);
  const targetPort = port || 5001;
  const proxyUrl = `ws://127.0.0.1:18901?host=${host}&port=${targetPort}`;
  console.log(`[file-transfer] connectFileTransfer -> proxy ws://127.0.0.1:18901, target host=${host}, port=${targetPort}`);
  try {
    await conn.connect(proxyUrl);
    console.log(`[file-transfer] connectFileTransfer: CONNECTED to ${host}:${targetPort}`);
  } catch (err) {
    console.error(`[file-transfer] connectFileTransfer FAILED to ${host}:${targetPort}: ${err.message}`);
    activeConnection = null;
    throw err;
  }
  activeConnection = conn;
  return conn;
}

function disconnectFileTransfer() {
  if (activeConnection) {
    activeConnection.disconnect();
    activeConnection = null;
  }
}

function setStatusListener(cb) {
  activeStatusListener = typeof cb === 'function' ? cb : null;
  if (activeConnection) activeConnection.setStatusListener(activeStatusListener);
}

function getActiveConnection() {
  return activeConnection;
}

module.exports = {
  FileTransferConnection,
  connectFileTransfer,
  disconnectFileTransfer,
  getActiveConnection,
  setStatusListener
};
