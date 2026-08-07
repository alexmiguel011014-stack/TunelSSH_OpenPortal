'use strict';

// Lado CLIENTE do túnel: roda na máquina que está ACESSANDO a outra.
// Envolve o socket já aprovado (ver connection-request.js) e fala o mesmo
// protocolo multiplexado do file-agent.js.
const fs = require('fs');
const path = require('path');
const {
  FrameDecoder,
  encodeJson,
  encodeBinary,
  encodeBinaryEnd,
  FRAME_JSON,
  FRAME_BINARY,
  FRAME_BINARY_END,
} = require('./protocol');

const CHUNK_SIZE = 64 * 1024;

class FileClient {
  constructor(socket) {
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.channelCounter = 0;
    this.pending = new Map(); // channelId -> { onJson, onData, onEnd }
    this.destroyed = false;

    this._onData = (buf) => {
      const frames = this.decoder.push(buf);
      for (const frame of frames) this._dispatch(frame);
    };
    this._onClose = () => this._teardown(new Error('Conexão com o túnel encerrada'));
    this._onError = (err) => this._teardown(err);

    this.socket.on('data', this._onData);
    this.socket.on('close', this._onClose);
    this.socket.on('error', this._onError);
  }

  _teardown(err) {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [, p] of this.pending) {
      try {
        p.reject ? p.reject(err) : null;
      } catch {}
    }
    this.pending.clear();
  }

  _nextChannelId() {
    this.channelCounter = (this.channelCounter + 1) >>> 0;
    if (this.channelCounter === 0) this.channelCounter = 1;
    return this.channelCounter;
  }

  _dispatch(frame) {
    const p = this.pending.get(frame.channelId);
    if (!p) return;
    if (frame.type === FRAME_JSON) {
      let msg;
      try {
        msg = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        return;
      }
      if (p.onJson) p.onJson(msg);
    } else if (frame.type === FRAME_BINARY) {
      if (p.onData) p.onData(frame.payload);
    } else if (frame.type === FRAME_BINARY_END) {
      if (p.onEnd) p.onEnd();
    }
  }

  _send(frame) {
    if (this.destroyed || this.socket.destroyed) throw new Error('Túnel desconectado');
    return this.socket.write(frame);
  }

  request(cmd, params = {}) {
    if (this.destroyed) return Promise.reject(new Error('Túnel desconectado'));
    const channelId = this._nextChannelId();
    return new Promise((resolve, reject) => {
      this.pending.set(channelId, {
        reject,
        onJson: (msg) => {
          this.pending.delete(channelId);
          if (msg.ok === false) reject(new Error(msg.error || 'Erro desconhecido'));
          else resolve(msg);
        },
      });
      try {
        this._send(encodeJson(channelId, { cmd, ...params }));
      } catch (err) {
        this.pending.delete(channelId);
        reject(err);
      }
    });
  }

  list(virtualPath) {
    return this.request('list', { path: virtualPath }).then((r) => r.entries);
  }

  stat(virtualPath) {
    return this.request('stat', { path: virtualPath });
  }

  mkdir(virtualPath) {
    return this.request('mkdir', { path: virtualPath });
  }

  remove(virtualPath) {
    return this.request('delete', { path: virtualPath });
  }

  rename(virtualPath, newVirtualPath) {
    return this.request('rename', { path: virtualPath, newPath: newVirtualPath });
  }

  // Percorre a árvore remota via list() recursivo (o protocolo não tem um
  // comando "walk" dedicado — cada nível é uma chamada `list`).
  async walkRemote(rootVirtualPath) {
    const out = [];
    const walk = async (vPath, relSegments) => {
      const entries = await this.list(vPath);
      if (entries.length === 0 && relSegments.length > 0) {
        out.push({ segments: relSegments, dir: true, size: 0 });
      }
      for (const entry of entries) {
        const childVPath = vPath === '/' ? `/${entry.name}` : `${vPath}/${entry.name}`;
        const segments = [...relSegments, entry.name];
        if (entry.dir) {
          out.push({ segments, dir: true, size: 0 });
          await walk(childVPath, segments);
        } else {
          out.push({ segments, dir: false, size: entry.size, virtualPath: childVPath });
        }
      }
    };
    await walk(rootVirtualPath, []);
    return out;
  }

  downloadToFile(virtualPath, localPath, onProgress) {
    if (this.destroyed) return Promise.reject(new Error('Túnel desconectado'));
    const channelId = this._nextChannelId();
    return new Promise((resolve, reject) => {
      let writeStream = null;
      let received = 0;
      let total = 0;
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        this.pending.delete(channelId);
        if (writeStream && !writeStream.destroyed) writeStream.destroy();
        if (err) reject(err);
        else resolve({ size: total });
      };

      this.pending.set(channelId, {
        reject: finish,
        onJson: (msg) => {
          if (msg.ok === false) return finish(new Error(msg.error || 'Falha ao baixar'));
          if (msg.cmd === 'get_res') {
            total = msg.size || 0;
            fs.mkdir(path.dirname(localPath), { recursive: true }, (mkErr) => {
              if (mkErr) return finish(mkErr);
              writeStream = fs.createWriteStream(localPath);
              writeStream.on('error', finish);
            });
          }
        },
        onData: (chunk) => {
          if (!writeStream) return;
          received += chunk.length;
          const flushed = writeStream.write(chunk);
          if (!flushed) {
            this.socket.pause();
            writeStream.once('drain', () => this.socket.resume());
          }
          if (onProgress) onProgress({ received, total });
        },
        onEnd: () => {
          if (!writeStream) return finish(new Error('Fluxo de dados incompleto'));
          writeStream.end(() => finish(null));
        },
      });

      try {
        this._send(encodeJson(channelId, { cmd: 'get', path: virtualPath }));
      } catch (err) {
        finish(err);
      }
    });
  }

  uploadFromFile(localPath, virtualPath, onProgress) {
    if (this.destroyed) return Promise.reject(new Error('Túnel desconectado'));
    const channelId = this._nextChannelId();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        this.pending.delete(channelId);
        if (err) reject(err);
        else resolve({ ok: true });
      };

      fs.stat(localPath, (statErr, st) => {
        if (statErr) return finish(statErr);
        const total = st.size;
        let sent = 0;

        this.pending.set(channelId, {
          reject: finish,
          onJson: (msg) => {
            if (msg.ok === false) return finish(new Error(msg.error || 'Falha ao enviar'));
            if (msg.cmd === 'put_res') {
              const readStream = fs.createReadStream(localPath, { highWaterMark: CHUNK_SIZE });
              readStream.on('data', (chunk) => {
                sent += chunk.length;
                try {
                  const flushed = this._send(encodeBinary(channelId, chunk));
                  if (!flushed) {
                    readStream.pause();
                    this.socket.once('drain', () => readStream.resume());
                  }
                } catch (err) {
                  readStream.destroy();
                  finish(err);
                  return;
                }
                if (onProgress) onProgress({ sent, total });
              });
              readStream.on('end', () => {
                try {
                  this._send(encodeBinaryEnd(channelId));
                } catch (err) {
                  finish(err);
                }
              });
              readStream.on('error', finish);
            } else if (msg.cmd === 'put_done') {
              finish(null);
            }
          },
        });

        try {
          this._send(encodeJson(channelId, { cmd: 'put', path: virtualPath }));
        } catch (err) {
          finish(err);
        }
      });
    });
  }

  close() {
    this.socket.removeListener('data', this._onData);
    this.socket.removeListener('close', this._onClose);
    this.socket.removeListener('error', this._onError);
    this._teardown(new Error('Desconectado'));
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

module.exports = { FileClient };
