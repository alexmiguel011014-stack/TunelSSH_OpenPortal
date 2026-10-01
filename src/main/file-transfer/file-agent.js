'use strict';

// Lado SERVIDOR do túnel: roda na máquina que está SENDO acessada.
// Recebe frames já decodificados (protocol.js) e executa comandos contra
// a raiz do usuário (os.homedir()), com caminhos virtuais POSIX no fio.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  encodeJson,
  encodeBinary,
  encodeBinaryEnd,
  FRAME_JSON,
  FRAME_BINARY,
  FRAME_BINARY_END,
} = require('./protocol');

const CHUNK_SIZE = 64 * 1024;

// Comandos que mudam algo no disco: uma sessão somente leitura (GOALS 18, "Ver
// pasta" do gerente) recusa todos.
const MUTATING_COMMANDS = new Set(['mkdir', 'delete', 'rename', 'put']);
const READ_ONLY_MESSAGE = 'Esta pasta é somente leitura';

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveNative(root, virtualPath) {
  const clean = String(virtualPath || '/').replace(/\\/g, '/');
  const parts = clean.split('/').filter((p) => p && p !== '.');
  for (const part of parts) {
    if (part === '..') throw new Error('Caminho fora da raiz permitida');
  }
  return parts.length ? path.join(root, ...parts) : root;
}

function toVirtual(root, nativePath) {
  const rel = path.relative(root, nativePath);
  if (rel.startsWith('..')) throw new Error('Caminho fora da raiz permitida');
  const posixRel = rel.split(path.sep).join('/');
  return posixRel ? `/${posixRel}` : '/';
}

class FileAgentSession {
  // readOnly: só lista, consulta e baixa; nada é criado, gravado, apagado ou
  // renomeado, e nenhum link (junção ou atalho simbólico) leva para fora da raiz.
  constructor(socket, root, { readOnly = false } = {}) {
    this.socket = socket;
    this.root = root || os.homedir();
    this.readOnly = readOnly === true;
    this.uploads = new Map(); // channelId -> { stream }
    // GOALS 4: contagem simples de arquivos que efetivamente terminaram de
    // ir/vir nesta sessão (envio + recebimento) — lida por
    // connection-request.js ao fechar a sessão para compor o evento de
    // atividade. Não distingue direção nem tamanho, só "quantos arquivos".
    this.filesTransferred = 0;
  }

  send(frame) {
    if (!this.socket.destroyed) this.socket.write(frame);
  }

  async handleFrame(frame) {
    const { type, channelId, payload } = frame;

    if (type === FRAME_JSON) {
      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      await this.handleCommand(channelId, msg);
      return;
    }

    if (this.readOnly) return;

    if (type === FRAME_BINARY) {
      const up = this.uploads.get(channelId);
      if (!up) return;
      const flushed = up.stream.write(payload);
      if (!flushed) {
        this.socket.pause();
        up.stream.once('drain', () => this.socket.resume());
      }
      return;
    }

    if (type === FRAME_BINARY_END) {
      const up = this.uploads.get(channelId);
      if (!up) return;
      up.stream.end(() => {
        this.uploads.delete(channelId);
        this.filesTransferred += 1;
        this.send(encodeJson(channelId, { cmd: 'put_done', ok: true }));
      });
    }
  }

  // O caminho nativo de um caminho virtual. Em sessão somente leitura, confere
  // também o caminho REAL: um link dentro da pasta não pode levar para fora dela.
  async nativePathOf(virtualPath) {
    const nativePath = resolveNative(this.root, virtualPath);
    if (!this.readOnly) return nativePath;
    const [realRoot, realTarget] = await Promise.all([
      fs.promises.realpath(this.root),
      fs.promises.realpath(nativePath),
    ]);
    if (!isInside(realRoot, realTarget)) throw new Error('Caminho fora da raiz permitida');
    return nativePath;
  }

  async handleCommand(channelId, msg) {
    try {
      if (this.readOnly && MUTATING_COMMANDS.has(msg.cmd)) {
        this.send(encodeJson(channelId, { ok: false, error: READ_ONLY_MESSAGE }));
        return;
      }
      switch (msg.cmd) {
        case 'list': {
          const nativeDir = await this.nativePathOf(msg.path);
          const entries = await fs.promises.readdir(nativeDir, {
            withFileTypes: true,
          });
          const items = [];
          for (const entry of entries) {
            try {
              const st = await fs.promises.stat(path.join(nativeDir, entry.name));
              items.push({
                name: entry.name,
                dir: entry.isDirectory(),
                size: st.size,
                mtime: st.mtimeMs,
              });
            } catch {}
          }
          this.send(
            encodeJson(channelId, {
              cmd: 'list_res',
              ok: true,
              path: msg.path,
              entries: items,
            }),
          );
          break;
        }

        case 'stat': {
          const nativePath = await this.nativePathOf(msg.path);
          const st = await fs.promises.stat(nativePath);
          this.send(
            encodeJson(channelId, {
              cmd: 'stat_res',
              ok: true,
              dir: st.isDirectory(),
              size: st.size,
              mtime: st.mtimeMs,
            }),
          );
          break;
        }

        case 'mkdir': {
          const nativePath = resolveNative(this.root, msg.path);
          await fs.promises.mkdir(nativePath, { recursive: true });
          this.send(encodeJson(channelId, { cmd: 'mkdir_res', ok: true }));
          break;
        }

        case 'delete': {
          const nativePath = resolveNative(this.root, msg.path);
          if (path.resolve(nativePath) === path.resolve(this.root)) {
            throw new Error('Não é permitido remover a raiz');
          }
          await fs.promises.rm(nativePath, { recursive: true, force: true });
          this.send(encodeJson(channelId, { cmd: 'delete_res', ok: true }));
          break;
        }

        case 'rename': {
          const fromNative = resolveNative(this.root, msg.path);
          const toNative = resolveNative(this.root, msg.newPath);
          if (path.resolve(fromNative) === path.resolve(this.root)) {
            throw new Error('Não é permitido renomear a raiz');
          }
          await fs.promises.rename(fromNative, toNative);
          this.send(encodeJson(channelId, { cmd: 'rename_res', ok: true }));
          break;
        }

        case 'get': {
          const nativePath = await this.nativePathOf(msg.path);
          const st = await fs.promises.stat(nativePath);
          this.send(
            encodeJson(channelId, {
              cmd: 'get_res',
              ok: true,
              size: st.size,
              name: path.basename(nativePath),
            }),
          );
          await this.streamFileOut(channelId, nativePath);
          this.filesTransferred += 1;
          break;
        }

        case 'put': {
          const nativePath = resolveNative(this.root, msg.path);
          await fs.promises.mkdir(path.dirname(nativePath), {
            recursive: true,
          });
          const stream = fs.createWriteStream(nativePath);
          this.uploads.set(channelId, { stream });
          stream.on('error', (err) => {
            this.uploads.delete(channelId);
            this.send(encodeJson(channelId, { ok: false, error: err.message }));
          });
          this.send(encodeJson(channelId, { cmd: 'put_res', ok: true }));
          break;
        }

        default:
          this.send(
            encodeJson(channelId, {
              ok: false,
              error: `Comando desconhecido: ${msg.cmd}`,
            }),
          );
      }
    } catch (err) {
      this.send(encodeJson(channelId, { ok: false, error: err.message }));
    }
  }

  streamFileOut(channelId, nativePath) {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(nativePath, {
        highWaterMark: CHUNK_SIZE,
      });

      readStream.on('data', (chunk) => {
        const flushed = this.socket.write(encodeBinary(channelId, chunk));
        if (!flushed) {
          readStream.pause();
          this.socket.once('drain', () => readStream.resume());
        }
      });

      readStream.on('end', () => {
        this.send(encodeBinaryEnd(channelId));
        resolve();
      });

      readStream.on('error', (err) => {
        this.send(encodeJson(channelId, { ok: false, error: err.message }));
        reject(err);
      });
    });
  }

  destroy() {
    for (const [, up] of this.uploads) {
      try {
        up.stream.destroy();
      } catch {}
    }
    this.uploads.clear();
  }
}

module.exports = { FileAgentSession, resolveNative, toVirtual };
