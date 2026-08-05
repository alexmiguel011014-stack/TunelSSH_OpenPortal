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
    this._suppressStatus = false;
    this._connectAcknowledged = false;
    this._host = '';
    this._port = 0;
  }

  connect(proxyUrl) {
    this._suppressStatus = false;
    this._connectAcknowledged = false;
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
        const wasAcknowledged = this._connectAcknowledged;
        this.connected = false;
        this._connectAcknowledged = false;
        this._rejectPending(reasonStr);
        this._failConnect(new Error(reasonStr));
        // Só notifica quedas depois do handshake `{t:'tcp', s:'ok'}` confirmado.
        // Falhas antes do ACK rejeitam connect() e são tratadas pelo retorno IPC.
        if (wasAcknowledged) {
          this._notifyStatus('disconnected', reasonStr, code);
        }
      });

      this.ws.on('error', (err) => {
        const wasAcknowledged = this._connectAcknowledged;
        this.connected = false;
        this._connectAcknowledged = false;
        this._rejectPending(err.message);
        this._failConnect(err);
        // Idem ao close: sem ACK confirmado, o erro pertence ao connect() e
        // deve ser entregue apenas pelo retorno IPC, não por ft:status.
        if (wasAcknowledged) {
          this._notifyStatus('error', err.message);
        }
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
      this._connectAcknowledged = true;
      this._resolveConnect();
    } else {
      this.connected = false;
      this._connectAcknowledged = false;
      this._rejectConnect(new Error(msg.m || 'Remote connection failed'));
    }
    this._resolveConnect = null;
    this._rejectConnect = null;
  }

  disconnect() {
    // Desconexão explícita: suprime notificações de status (o IPC `ft:disconnect`
    // já comunica o estado) para que eventos assíncronos `error`/`close` desta
    // instância não derrubem a UI depois que outra conexão já está ativa.
    this._suppressStatus = true;
    this._connectAcknowledged = false;
    this._failConnect(new Error('Disconnected'));
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this._rejectPending('Disconnected');
  }

  setStatusListener(cb) {
    this._onStatus = typeof cb === 'function' ? cb : null;
  }

  _notifyStatus(state, message, code) {
    if (this._suppressStatus) return;
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
    // Entradas de list/delete/mkdir possuem `reject`; entradas de download
    // (states com `_callback`) não possuem `.reject` e são finalizadas via
    // callback com { s: 'err' }. Usa snapshot antes de limpar os mapas para
    // evitar iteração inválida quando o callback muta o estado.
    const pendingEntries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of pendingEntries) {
      if (entry._timeout) clearTimeout(entry._timeout);
      if (typeof entry.reject === 'function') {
        entry.reject(new Error(reason));
      } else if (typeof entry._callback === 'function') {
        entry._callback({ s: 'err', m: reason });
      }
    }
    const uploadEntries = Array.from(this.pendingUploads.values());
    this.pendingUploads.clear();
    for (const entry of uploadEntries) {
      if (entry._timeout) clearTimeout(entry._timeout);
      if (typeof entry.reject === 'function') {
        entry.reject(new Error(reason));
      } else if (typeof entry._callback === 'function') {
        entry._callback({ s: 'err', m: reason });
      }
    }
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
          if (typeof entry._restartTimeout === 'function') entry._restartTimeout();
        } else if (this.currentGet) {
          this.currentGet.totalSize = msg.z;
          this.currentGet.basename = msg.n;
          if (typeof this.currentGet._restartTimeout === 'function') this.currentGet._restartTimeout();
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
        if (typeof target._restartTimeout === 'function') target._restartTimeout();
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
      // Janela de inatividade: reinicia o timer a cada get_res OK e a cada
      // MSG_BINARY recebido. O download só aborta se não houver resposta nem
      // chunk por 30s; finish() é quem garante o clearTimeout final.
      state._restartTimeout = () => {
        clearTimeout(state._timeout);
        state._timeout = setTimeout(() => {
          finish(new Error(`Timeout sem resposta ou dados (id=${id})`));
        }, 30000);
      };
      state._restartTimeout();

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
let connectingConnection = null;
let activeStatusListener = null;
let connectionGen = 0;

async function connectFileTransfer(host, port) {
  const gen = ++connectionGen;
  // Desconecta qualquer conexão anterior (ativa ou ainda em andamento)
  // para que somente a mais recente possa se tornar a conexão ativa.
  if (connectingConnection) {
    connectingConnection.disconnect();
    connectingConnection = null;
  }
  const prev = activeConnection;
  activeConnection = null;
  if (prev) {
    prev.disconnect();
  }

  const conn = new FileTransferConnection();
  conn._host = host;
  conn._port = port || 5001;
  if (activeStatusListener) conn.setStatusListener(activeStatusListener);
  const targetPort = port || 5001;
  const proxyUrl = `ws://127.0.0.1:18901?host=${host}&port=${targetPort}`;
  console.log(`[file-transfer] connectFileTransfer -> proxy ws://127.0.0.1:18901, target host=${host}, port=${targetPort} (gen=${gen})`);
  connectingConnection = conn;
  try {
    await conn.connect(proxyUrl);
    console.log(`[file-transfer] connectFileTransfer: CONNECTED to ${host}:${targetPort} (gen=${gen})`);
  } catch (err) {
    if (connectingConnection === conn) connectingConnection = null;
    if (gen === connectionGen) activeConnection = null;
    // Encerra/suprime a instância que falhou (fecha o socket e marca
    // `_suppressStatus`) para que eventos tardios `error`/`close` desta
    // conexão obsoleta não alcancem o renderer. O erro original é re-lançado.
    conn.disconnect();
    console.error(`[file-transfer] connectFileTransfer FAILED to ${host}:${targetPort}: ${err.message}`);
    throw err;
  }
  if (connectingConnection === conn) connectingConnection = null;
  if (gen === connectionGen) {
    activeConnection = conn;
  } else {
    // Uma conexão mais nova foi solicitada enquanto esta terminava:
    // encerra esta e não substitui a atual.
    console.log(`[file-transfer] connectFileTransfer: stale connection discarded (gen=${gen}, current=${connectionGen})`);
    conn.disconnect();
  }
  return conn;
}

function disconnectFileTransfer() {
  connectionGen++;
  if (connectingConnection) {
    connectingConnection.disconnect();
    connectingConnection = null;
  }
  const prev = activeConnection;
  activeConnection = null;
  if (prev) {
    prev.disconnect();
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
