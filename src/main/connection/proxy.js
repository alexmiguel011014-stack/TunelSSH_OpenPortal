const WebSocket = require('ws');
const net = require('net');
const { URL } = require('url');
const { isAllowedHost } = require('./net-guard');
const { SIGNAL_PORT } = require('./connection-request');

const CONNECT_TIMEOUT = 10000;
const IDLE_TIMEOUT = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL = 30000; // ping WS a cada 30s
const HEARTBEAT_MAX_MISSED = 2; // encerra após ~60s sem pong

// getTunnelToken(host) devolve o token da sessão aprovada com aquele PC (ou '').
function startWebSocketProxy(
  port = 18900,
  { getTunnelToken = null, tunnelPort = SIGNAL_PORT } = {},
) {
  // Só o renderer deste PC usa o proxy: escutar em todas as interfaces deixava
  // outros PCs da rede usá-lo para abrir conexões TCP a partir daqui.
  const wss = new WebSocket.Server({ host: '127.0.0.1', port });

  wss.on('error', (err) => {
    console.error(`[proxy] WebSocket server error (port ${port}):`, err.message);
  });

  wss.on('connection', (ws, req) => {
    let tcpSocket = null;
    let settled = false;
    let missedPongs = 0;
    let heartbeatTimer = null;

    const url = new URL(req.url, 'http://localhost');
    const targetHost = url.searchParams.get('host');
    const targetPort = parseInt(url.searchParams.get('port') || '5900', 10);
    console.log(`[proxy] New WebSocket connection: target ${targetHost}:${targetPort}`);

    if (!targetHost) {
      ws.close(4001, 'Missing host parameter');
      return;
    }

    if (!isAllowedHost(targetHost)) {
      ws.close(4002, 'Invalid host: must be a Tailscale IP (100.x)');
      return;
    }

    // Heartbeat do WebSocket: detecta desconexão silenciosa do renderer.
    // O browser (noVNC) responde pong automaticamente a cada ping.
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const startHeartbeat = () => {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          stopHeartbeat();
          return;
        }
        if (missedPongs >= HEARTBEAT_MAX_MISSED) {
          console.error(
            `[proxy] Heartbeat lost for ${targetHost}:${targetPort} (${missedPongs + 1} missed pongs). Closing.`,
          );
          if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
          ws.close(4004, 'Heartbeat timeout');
          stopHeartbeat();
          return;
        }
        missedPongs++;
        try {
          ws.ping();
        } catch {}
      }, HEARTBEAT_INTERVAL);
    };

    ws.on('pong', () => {
      missedPongs = 0;
    });

    // GOALS 10: com o token da sessão aprovada, o VNC vai pelo túnel da porta
    // de pedidos até o TightVNC local do outro PC; sem token (PC remoto com a
    // versão antiga), segue direto para a 5900 como antes.
    const tunnelToken = getTunnelToken ? getTunnelToken(targetHost) : '';
    let awaitingTunnel = Boolean(tunnelToken);
    let handshake = Buffer.alloc(0);
    tcpSocket = tunnelToken
      ? net.createConnection(tunnelPort, targetHost)
      : net.createConnection(targetPort, targetHost);

    tcpSocket.setNoDelay(true);
    tcpSocket.setKeepAlive(true, 5000);

    const connectTimer = setTimeout(() => {
      if (!settled && !tcpSocket.destroyed) {
        tcpSocket.destroy(new Error('Connection timeout'));
      }
    }, CONNECT_TIMEOUT);

    tcpSocket.on('connect', () => {
      if (tunnelToken) {
        console.log(`[proxy] TCP connected to ${targetHost}:${tunnelPort}, pedindo túnel VNC`);
        tcpSocket.write(`${JSON.stringify({ type: 'vnc-tunnel', token: tunnelToken })}\n`);
      } else {
        console.log(`[proxy] TCP connected to ${targetHost}:${targetPort}`);
      }
      settled = true;
      clearTimeout(connectTimer);
      tcpSocket.setTimeout(IDLE_TIMEOUT);
      startHeartbeat();
    });

    tcpSocket.on('timeout', () => {
      stopHeartbeat();
      if (!tcpSocket.destroyed) tcpSocket.destroy(new Error('Idle timeout'));
    });

    tcpSocket.on('data', (chunk) => {
      let payload = chunk;
      if (awaitingTunnel) {
        // Primeira linha do host: o veredito do túnel; o resto já é RFB.
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf(0x0a);
        if (end < 0) return;
        let reply = null;
        try {
          reply = JSON.parse(handshake.subarray(0, end).toString('utf8'));
        } catch {}
        if (reply?.type !== 'vnc-tunnel-ok') {
          console.error(
            `[proxy] Túnel VNC recusado por ${targetHost}: ${reply?.reason || 'resposta inválida'}`,
          );
          tcpSocket.destroy();
          if (ws.readyState === WebSocket.OPEN) ws.close(4005, 'VNC tunnel refused');
          return;
        }
        awaitingTunnel = false;
        payload = handshake.subarray(end + 1);
        handshake = null;
        if (payload.length === 0) return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    });

    ws.on('message', (data) => {
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.write(data);
      }
    });

    tcpSocket.on('error', (err) => {
      stopHeartbeat();
      clearTimeout(connectTimer);
      console.error(`[proxy] TCP error (${targetHost}:${targetPort}):`, err.code, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4003, `TCP error: ${err.message}`);
      }
    });

    tcpSocket.on('close', () => {
      clearTimeout(connectTimer);
      stopHeartbeat();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'TCP closed');
      }
    });

    ws.on('close', () => {
      stopHeartbeat();
      clearTimeout(connectTimer);
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.destroy();
      }
    });

    ws.on('error', () => {
      stopHeartbeat();
      clearTimeout(connectTimer);
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.destroy();
      }
    });
  });

  wss.on('listening', () => {
    console.log(`[proxy] WebSocket proxy listening on ws://127.0.0.1:${wss.address().port}`);
  });
  return wss;
}

module.exports = { startWebSocketProxy };
