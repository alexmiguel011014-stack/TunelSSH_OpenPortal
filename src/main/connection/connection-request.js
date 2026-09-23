const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const { FileAgentSession } = require('../file-transfer/file-agent');
const { FrameDecoder } = require('../file-transfer/protocol');

const SIGNAL_PORT = 18902;
// Dois prazos distintos: abrir o TCP é rápido (falha → pode tentar de novo),
// mas depois que o pedido chega o PC remoto mostra "Aceitar/Rejeitar" e uma
// pessoa precisa ir até lá clicar — 15s totais não bastavam, e cada nova
// tentativa abria OUTRA janela de aprovação lá (aceitar a antiga não fazia nada).
const CONNECT_TIMEOUT = 8000;
const DECISION_TIMEOUT = 60000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 5000;

// Emite 'file-session-open'/'file-session-close' (com o req da conexão)
// quando um pedido aprovado vira sessão de arquivos — usado pelo main.js
// para mostrar o aviso "alguém está conectado". É uma aproximação: a sessão
// VNC em si (porta 5900) fala direto com o TightVNC, sem passar por este
// servidor, então não há como observar seu início/fim de verdade — mas como
// o App.jsx abre e fecha a sessão de arquivos junto com a sessão VNC (mesmo
// clique de conectar/desconectar), esse sinal reflete bem a sessão na prática.
// Também emite 'activity-event' (GOALS 4): mensagem fire-and-forget enviada
// por OUTRA instância deste app para reportar uma sessão que aconteceu lá.
class ConnectionRequestServer extends EventEmitter {
  constructor(onRequest) {
    super();
    this.onRequest = onRequest;
    this.server = null;
  }

  start(port = SIGNAL_PORT, { retryInUseMs = 5000 } = {}) {
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
          // GOALS 4 lê isso em 'file-session-close' para contar arquivos
          // movidos na sessão — ver file-agent.js's filesTransferred.
          req.filesTransferred = session.filesTransferred;
          session.destroy();
          this.emit('file-session-close', req);
        };
        socket.on('close', onFileSessionEnd);
        socket.on('error', onFileSessionEnd);
      };

      // Se quem pediu desistir (timeout/cancelou) antes da decisão, o host
      // fecha a janela de aprovação pendente em vez de deixá-la órfã.
      const pendingDecision = new AbortController();
      socket.on('close', () => pendingDecision.abort());

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
            // Self-reported by the client — display-only (e.g. in the
            // approval dialog). Never use this for an authorization
            // decision: remoteAddress below is the value that can't be
            // spoofed by the payload.
            fromIp: msg.fromIp || '',
            remoteAddress: socket.remoteAddress || '',
            capability: wantsTunnel ? 'tunnel' : 'vnc',
          };

          const respond = (payload) => {
            if (socket.destroyed) return;
            const approved = !!payload.approved;
            // Se rejeitado explicitamente, marca para o cliente saber
            const finalPayload =
              wantsTunnel && approved
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
            // A senha de acesso vai à parte: `req` circula por eventos e pelo
            // log de atividade e não pode carregá-la.
            const sessionPassword =
              typeof msg.sessionPassword === 'string' ? msg.sessionPassword : '';
            this.onRequest(req, respond, pendingDecision.signal, sessionPassword);
          } else {
            respond({
              type: 'connect-response',
              requestId: req.requestId,
              approved: false,
              message: 'Server not ready',
            });
          }
        } else if (msg.type === 'activity-event') {
          // Fire-and-forget (GOALS 4): sem resposta esperada, nunca abre
          // sessão de arquivos nem interfere num connect-request em curso
          // na mesma porta.
          this.emit('activity-event', msg.event);
          if (!socket.destroyed) socket.end();
        } else {
          if (!socket.destroyed) {
            socket.write(
              JSON.stringify({
                type: 'connect-response',
                approved: false,
                message: 'Unknown request',
              }),
            );
            socket.end();
          }
        }
      };

      socket.on('data', dataHandler);
      socket.on('error', () => {});
    });

    this.server.on('error', (err) => {
      console.error('[connection-request] Server error:', err.message);
      // Outra cópia do app (ex.: a versão instalada) segura a porta: sem isto
      // este app ficava aberto mas surdo para pedidos de acesso até reiniciar.
      if (err.code === 'EADDRINUSE' && retryInUseMs > 0) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.server?.listen(port, '0.0.0.0'), retryInUseMs);
      }
    });

    this.server.listen(port, '0.0.0.0', () => {
      console.log(`[connection-request] Listening on port ${port}`);
    });

    return this.server;
  }

  stop() {
    clearTimeout(this.retryTimer);
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// `delivered`: o pedido já chegou ao PC remoto (TCP aberto e pedido escrito).
// Antes disso vale tentar de novo; depois, o PC remoto já mostra a janela de
// aprovação e repetir só empilharia outra janela lá.
function requestError(message, delivered) {
  const err = new Error(message);
  err.delivered = delivered;
  return err;
}

function sendConnectRequestOnce(host, fromName, fromIp, port = SIGNAL_PORT, opts = {}) {
  const wantsTunnel = !!opts.wantsTunnel;
  const connectTimeout = opts.connectTimeoutMs || CONNECT_TIMEOUT;
  const decisionTimeout = opts.decisionTimeoutMs || DECISION_TIMEOUT;

  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = net.createConnection(port, host);
    } catch (err) {
      return reject(err);
    }

    let responded = false;
    let delivered = false;
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
      fail(
        requestError(
          `Não foi possível contactar ${host}:${port} (sem resposta em ${connectTimeout / 1000}s) — verifique se o OpenPortal está aberto no PC remoto e se o Firewall do Windows liberou o app`,
          false,
        ),
      );
    }, connectTimeout);

    socket.on('connect', () => {
      delivered = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail(
          requestError(
            `O PC remoto recebeu o pedido, mas ninguém respondeu em ${decisionTimeout / 1000}s — clique em "Aceitar" na janela "Solicitação de conexão" do OpenPortal no PC remoto`,
            true,
          ),
        );
      }, decisionTimeout);
      socket.write(
        JSON.stringify({
          type: 'connect-request',
          requestId: String(Date.now()),
          fromName,
          fromIp,
          capability: wantsTunnel ? 'tunnel' : undefined,
          sessionPassword: opts.sessionPassword || undefined,
        }),
      );
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

      // Senha do TightVNC do PC remoto, entregue junto com a aprovação.
      const vncPassword = typeof msg.vncPassword === 'string' ? msg.vncPassword : '';

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
        resolve({ approved: true, message: msg.message || '', vncPassword, socket });
        return;
      }

      if (!socket.destroyed) socket.destroy();
      resolve({
        approved: !!msg.approved,
        rejected: msg.rejected === true,
        message: msg.message || '',
        vncPassword,
      });
    });

    socket.on('error', (err) => {
      const hint =
        err.code === 'ECONNREFUSED' ? ' — verifique se o OpenPortal está aberto no PC remoto' : '';
      fail(
        requestError(
          `Não foi possível contactar ${host}:${port} (${err.code || err.message})${hint}`,
          delivered,
        ),
      );
    });

    socket.on('close', () => {
      fail(requestError('Conexão encerrada pelo PC remoto', delivered));
    });
  });
}

function sendConnectRequest(host, fromName, fromIp, port = SIGNAL_PORT, opts = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const retryDelay = opts.retryDelayMs ?? RETRY_DELAY;

  return (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(retryDelay);
      try {
        const res = await sendConnectRequestOnce(host, fromName, fromIp, port, opts);
        return res;
      } catch (err) {
        lastError = err;
        console.error(
          `[connection-request] Tentativa ${attempt}/${MAX_ATTEMPTS} falhou para ${host}:${port}: ${err.message}`,
        );
        if (err.delivered) break;
      }
    }
    throw lastError || new Error('Falha ao contactar o PC remoto');
  })();
}

// Push best-effort usado por GOALS 4: sem retry (ao contrário de
// sendConnectRequest) e sem resposta esperada — se o peer estiver
// inalcançável, o erro é simplesmente descartado. A sessão em si já
// aconteceu e não é perdida, só o aviso ao vivo é que fica sem entrega.
function sendActivityEvent(host, event, port = SIGNAL_PORT) {
  try {
    const socket = net.createConnection(port, host);
    socket.setTimeout(4000, () => socket.destroy());
    socket.on('connect', () => {
      socket.end(JSON.stringify({ type: 'activity-event', event }));
    });
    socket.on('error', () => {});
  } catch {}
}

module.exports = {
  ConnectionRequestServer,
  sendConnectRequest,
  sendActivityEvent,
  SIGNAL_PORT,
};
