const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const { FileAgentSession } = require('../file-transfer/file-agent');
const { FrameDecoder } = require('../file-transfer/protocol');

const SIGNAL_PORT = 18902;
const REQUEST_TIMEOUT = 15000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 5000;

// Emite 'file-session-open'/'file-session-close' (com o req da conexão)
// quando um pedido aprovado vira sessão de arquivos — usado pelo main.js
// para mostrar o aviso "alguém está conectado". É uma aproximação: a sessão
// VNC em si (porta 5900) fala direto com o TightVNC, sem passar por este
// servidor, então não há como observar seu início/fim de verdade — mas como
// o App.jsx abre e fecha a sessão de arquivos junto com a sessão VNC (mesmo
// clique de conectar/desconectar), esse sinal reflete bem a sessão na prática.
class ConnectionRequestServer extends EventEmitter {
  constructor(onRequest) {
    super();
    this.onRequest = onRequest;
    this.server = null;
  }

  start(port = SIGNAL_PORT) {
    if (this.server) return this.server;

    this.server = net.createServer((socket) => {
      socket.setNoDelay(true);
      let buffer = Buffer.alloc(0);

      // Upgrade: depois de aprovar um pedido com capability:'tunnel' (nome
      // de campo do wire-protocol, mantido por estabilidade — ver
      // file-transfer-session.js para a sessão de arquivos em si), o socket
      // NÃO é fechado — vira o transporte multiplexado de transferência de
      // arquivos (ver file-agent.js / protocol.js). Isso evita abrir uma
      // porta TCP nova (e a regra de firewall que ela exigiria): reaproveita
      // esta conexão, que o Windows já deixa passar.
      const upgradeToFileSession = (req) => {
        socket.removeListener('data', dataHandler);
        const session = new FileAgentSession(socket, os.homedir());
        const decoder = new FrameDecoder();
        socket.on('data', (chunk) => {
          const frames = decoder.push(chunk);
          for (const frame of frames) {
            session.handleFrame(frame).catch(() => {});
          }
        });
        this.emit('file-session-open', req);
        let closed = false;
        const onFileSessionEnd = () => {
          if (closed) return;
          closed = true;
          session.destroy();
          this.emit('file-session-close', req);
        };
        socket.on('close', onFileSessionEnd);
        socket.on('error', onFileSessionEnd);
      };

      const dataHandler = (d) => {
        buffer = Buffer.concat([buffer, d]);
        let msg = null;
        try {
          msg = JSON.parse(buffer.toString('utf8'));
        } catch {}
        if (!msg) return;

        if (msg.type === 'connect-request') {
          const wantsTunnel = msg.capability === 'tunnel';
          const req = {
            requestId: msg.requestId || String(Date.now()),
            fromName: msg.fromName || 'Desconhecido',
            fromIp: msg.fromIp || '',
            capability: wantsTunnel ? 'tunnel' : 'vnc'
          };

          const respond = (payload) => {
            if (socket.destroyed) return;
            const approved = !!payload.approved;
            // Se rejeitado explicitamente, marca para o cliente saber
            const finalPayload = wantsTunnel && approved
              ? { ...payload, tunnel: true }
              : { ...payload, rejected: !approved };
            socket.write(JSON.stringify(finalPayload));
            if (wantsTunnel && approved) {
              upgradeToFileSession(req);
            } else {
              socket.end();
            }
          };

          if (this.onRequest) {
            this.onRequest(req, respond);
          } else {
            respond({ type: 'connect-response', requestId: req.requestId, approved: false, message: 'Server not ready' });
          }
        } else {
          if (!socket.destroyed) {
            socket.write(JSON.stringify({ type: 'connect-response', approved: false, message: 'Unknown request' }));
            socket.end();
          }
        }
      };

      socket.on('data', dataHandler);
      socket.on('error', () => {});
    });

    this.server.on('error', (err) => {
      console.error('[connection-request] Server error:', err.message);
    });

    this.server.listen(port, '0.0.0.0', () => {
      console.log(`[connection-request] Listening on port ${port}`);
    });

    return this.server;
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

function sendConnectRequestOnce(host, fromName, fromIp, port = SIGNAL_PORT, opts = {}) {
  const wantsTunnel = !!opts.wantsTunnel;

  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = net.createConnection(port, host);
    } catch (err) {
      return reject(err);
    }

    let responded = false;
    let buffer = Buffer.alloc(0);
    let timer = null;

    const fail = (err) => {
      if (responded) return;
      responded = true;
      if (timer) clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      reject(err);
    };

    timer = setTimeout(() => {
      fail(new Error('Sem resposta do PC remoto (timeout de 15s) — verifique se o OpenPortal está aberto lá e se o Firewall do Windows não bloqueou o app na primeira execução'));
    }, REQUEST_TIMEOUT);

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        type: 'connect-request',
        requestId: String(Date.now()),
        fromName,
        fromIp,
        capability: wantsTunnel ? 'tunnel' : undefined
      }));
    });

    socket.on('data', (d) => {
      if (responded) return;
      buffer = Buffer.concat([buffer, d]);
      let msg = null;
      try {
        msg = JSON.parse(buffer.toString('utf8'));
      } catch {}
      if (!msg) return;
      responded = true;
      if (timer) clearTimeout(timer);

      if (msg.type !== 'connect-response') {
        if (!socket.destroyed) socket.destroy();
        resolve({ approved: false, message: 'Resposta inválida do PC remoto' });
        return;
      }

      // Sessão de arquivos aprovada: NÃO destrói o socket, ele vira o
      // transporte de arquivos (ver file-transfer-session.js / file-client.js).
      if (wantsTunnel && msg.approved && msg.tunnel) {
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        resolve({ approved: true, message: msg.message || '', socket });
        return;
      }

      if (!socket.destroyed) socket.destroy();
      resolve({ approved: !!msg.approved, message: msg.message || '' });
    });

    socket.on('error', (err) => {
      const hint = err.code === 'ECONNREFUSED' ? ' — verifique se o OpenPortal está aberto no PC remoto' : '';
      fail(new Error(`Não foi possível contactar ${host}:${port} (${err.code || err.message})${hint}`));
    });

    socket.on('close', () => {
      fail(new Error('Conexão encerrada pelo PC remoto'));
    });
  });
}

function sendConnectRequest(host, fromName, fromIp, port = SIGNAL_PORT, opts = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(RETRY_DELAY);
      try {
        const res = await sendConnectRequestOnce(host, fromName, fromIp, port, opts);
        return res;
      } catch (err) {
        lastError = err;
        console.error(`[connection-request] Tentativa ${attempt}/${MAX_ATTEMPTS} falhou para ${host}:${port}: ${err.message}`);
      }
    }
    throw lastError || new Error('Falha ao contactar o PC remoto');
  })();
}

module.exports = { ConnectionRequestServer, sendConnectRequest, SIGNAL_PORT };
