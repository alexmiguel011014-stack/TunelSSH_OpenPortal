const net = require('net');

const SIGNAL_PORT = 18902;
const REQUEST_TIMEOUT = 15000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY = 5000;

class ConnectionRequestServer {
  constructor(onRequest) {
    this.onRequest = onRequest;
    this.server = null;
  }

  start(port = SIGNAL_PORT) {
    if (this.server) return this.server;

    this.server = net.createServer((socket) => {
      socket.setNoDelay(true);
      let buffer = Buffer.alloc(0);

      const respond = (payload) => {
        if (socket.destroyed) return;
        socket.write(JSON.stringify(payload));
        socket.end();
      };

      socket.on('data', (d) => {
        buffer = Buffer.concat([buffer, d]);
        let msg = null;
        try {
          msg = JSON.parse(buffer.toString('utf8'));
        } catch {}
        if (!msg) return;

        if (msg.type === 'connect-request') {
          const req = {
            requestId: msg.requestId || String(Date.now()),
            fromName: msg.fromName || 'Desconhecido',
            fromIp: msg.fromIp || ''
          };
          if (this.onRequest) {
            this.onRequest(req, respond);
          } else {
            respond({ type: 'connect-response', approved: false, message: 'Server not ready' });
          }
        } else {
          respond({ type: 'connect-response', approved: false, message: 'Unknown request' });
        }
      });

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

function sendConnectRequestOnce(host, fromName, fromIp, port = SIGNAL_PORT) {
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
      fail(new Error('Sem resposta do PC remoto (timeout de 15s)'));
    }, REQUEST_TIMEOUT);

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        type: 'connect-request',
        requestId: String(Date.now()),
        fromName,
        fromIp
      }));
    });

    socket.on('data', (d) => {
      buffer = Buffer.concat([buffer, d]);
      let msg = null;
      try {
        msg = JSON.parse(buffer.toString('utf8'));
      } catch {}
      if (!msg) return;
      responded = true;
      if (timer) clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      if (msg.type === 'connect-response') {
        resolve({ approved: !!msg.approved, message: msg.message || '' });
      } else {
        resolve({ approved: false, message: 'Resposta inválida do PC remoto' });
      }
    });

    socket.on('error', (err) => {
      fail(new Error(`Não foi possível contactar ${host}:${port} (${err.code || err.message})`));
    });

    socket.on('close', () => {
      fail(new Error('Conexão encerrada pelo PC remoto'));
    });
  });
}

function sendConnectRequest(host, fromName, fromIp, port = SIGNAL_PORT) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(RETRY_DELAY);
      try {
        const res = await sendConnectRequestOnce(host, fromName, fromIp, port);
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
