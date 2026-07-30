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
    this.idCounter = 0;
    this.connected = false;
    this._resolveConnect = null;
    this._rejectConnect = null;
    this.currentGet = null;
  }

  connect(proxyUrl) {
    return new Promise((resolve, reject) => {
      this._resolveConnect = resolve;
      this._rejectConnect = reject;

      this.ws = new WebSocket(proxyUrl);
      this.ws.binaryType = 'nodebuffer';

      this.ws.on('open', () => {
        this.connected = true;
        if (this._resolveConnect) {
          this._resolveConnect();
          this._resolveConnect = null;
          this._rejectConnect = null;
        }
      });

      this.ws.on('message', (data) => {
        const buf = Buffer.from(data);
        const frames = this.decoder.feed(buf);
        for (const frame of frames) {
          this._handleFrame(frame);
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this._rejectPending('Connection closed');
        if (this._rejectConnect) {
          this._rejectConnect(new Error('Connection closed'));
          this._resolveConnect = null;
          this._rejectConnect = null;
        }
      });

      this.ws.on('error', (err) => {
        this.connected = false;
        this._rejectPending(err.message);
        if (this._rejectConnect) {
          this._rejectConnect(err);
          this._resolveConnect = null;
          this._rejectConnect = null;
        }
      });
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this._rejectPending('Disconnected');
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
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.currentGet = null;
  }

  _handleFrame(frame) {
    if (frame.type === MSG_JSON) {
      const msg = JSON.parse(frame.payload.toString('utf8'));

      if (msg.t === 'get_res' && msg.s === 'ok') {
        this.currentGet = {
          chunks: [],
          totalSize: msg.z,
          receivedSize: 0
        };
        return;
      }

      if (msg.t === 'get_done' || (msg.t === 'get_res' && msg.s !== 'ok')) {
        const getCb = this.currentGet;
        this.currentGet = null;
        if (getCb && getCb._callback) {
          getCb._callback(msg);
        }
        return;
      }

      const entry = this.pending.get(msg.i);
      if (entry) {
        this.pending.delete(msg.i);
        entry.resolve(msg);
      }
      return;
    }

    if (frame.type === MSG_BINARY) {
      if (this.currentGet) {
        this.currentGet.chunks.push(frame.payload);
        this.currentGet.receivedSize += frame.payload.length;
        if (this.currentGet._onProgress) {
          this.currentGet._onProgress(this.currentGet.receivedSize, this.currentGet.totalSize);
        }
      }
      return;
    }

    if (frame.type === MSG_BINARY_END) {
      if (this.currentGet) {
        const getCb = this.currentGet;
        this.currentGet = null;
        if (getCb._callback) {
          getCb._callback({ s: 'ok', data: Buffer.concat(getCb.chunks), size: getCb.totalSize });
        }
      }
      return;
    }
  }

  async listFiles(remotePath) {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._sendJson({ t: 'list', p: remotePath, i: id });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async downloadFile(remotePath, onProgress) {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      this.currentGet = {
        chunks: [],
        totalSize: 0,
        receivedSize: 0,
        _callback: (msg) => {
          if (msg.s === 'ok' && msg.data) {
            resolve({ data: msg.data, size: msg.size });
          } else if (msg.s === 'err') {
            reject(new Error(msg.m || 'Download failed'));
          } else if (msg.s === 'ok' && !msg.data) {
            resolve({ data: Buffer.concat(this.currentGet.chunks), size: this.currentGet.totalSize });
          }
        }
      };
      if (onProgress) {
        this.currentGet._onProgress = onProgress;
      }
      try {
        this._sendJson({ t: 'get', p: remotePath, i: id });
      } catch (err) {
        this.currentGet = null;
        reject(err);
      }
    });
  }

  async uploadFile(remotePath, data, onProgress) {
    const id = ++this.idCounter;
    const totalSize = data.length;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._sendJson({ t: 'put', p: remotePath, z: totalSize, i: id });

        let offset = 0;
        const sendChunks = () => {
          const chunk = data.slice(offset, offset + CHUNK_SIZE);
          if (chunk.length === 0) {
            this._sendBinaryEnd();
            return;
          }
          this._sendBinary(chunk);
          offset += chunk.length;
          if (onProgress) onProgress(offset, totalSize);
          setImmediate(sendChunks);
        };
        setImmediate(sendChunks);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async deleteFile(remotePath) {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._sendJson({ t: 'delete', p: remotePath, i: id });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async createDirectory(remotePath) {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this._sendJson({ t: 'mkdir', p: remotePath, i: id });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}

let activeConnection = null;

async function connectFileTransfer(host, port) {
  if (activeConnection) {
    activeConnection.disconnect();
  }
  const conn = new FileTransferConnection();
  const proxyUrl = `ws://127.0.0.1:18901?host=${host}&port=${port || 5001}`;
  await conn.connect(proxyUrl);
  activeConnection = conn;
  return conn;
}

function disconnectFileTransfer() {
  if (activeConnection) {
    activeConnection.disconnect();
    activeConnection = null;
  }
}

function getActiveConnection() {
  return activeConnection;
}

module.exports = {
  FileTransferConnection,
  connectFileTransfer,
  disconnectFileTransfer,
  getActiveConnection
};
