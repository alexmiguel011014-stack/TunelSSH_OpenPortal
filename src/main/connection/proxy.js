const WebSocket = require('ws');
const net = require('net');
const { URL } = require('url');

const isDev = process.env.NODE_ENV === 'development';

const CONNECT_TIMEOUT = 10000;
const IDLE_TIMEOUT = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL = 30000;   // ping WS a cada 30s
const HEARTBEAT_MAX_MISSED = 2;     // encerra após ~60s sem pong

function isAllowedHost(host) {
  if (!host) return false;
  if (isDev && (host === '127.0.0.1' || host === 'localhost')) return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const a = parseInt(parts[0], 10);
  const b = parseInt(parts[1], 10);
  if (a === 100) return true;                                    // Tailscale (CGNAT 100.64/10)
  if (a === 10) return true;                                     // 10/8
  if (a === 192 && b === 168) return true;                       // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true;              // 172.16/12
  return false;
}

function startWebSocketProxy(port = 18900) {
  const wss = new WebSocket.Server({ port });

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

    if (!targetHost) {
      ws.close(4001, 'Missing host parameter');
      return;
    }

    if (!isAllowedHost(targetHost)) {
      ws.close(4002, 'Invalid host: must be a private/Tailscale IP (100.x, 10.x, 192.168.x, 172.x)');
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
          console.error(`[proxy] Heartbeat lost for ${targetHost}:${targetPort} (${missedPongs + 1} missed pongs). Closing.`);
          if (tcpSocket && !tcpSocket.destroyed) tcpSocket.destroy();
          ws.close(4004, 'Heartbeat timeout');
          stopHeartbeat();
          return;
        }
        missedPongs++;
        try {
          ws.ping();
        } catch (e) {}
      }, HEARTBEAT_INTERVAL);
    };

    ws.on('pong', () => {
      missedPongs = 0;
    });

    tcpSocket = net.createConnection(targetPort, targetHost);

    tcpSocket.setNoDelay(true);
    tcpSocket.setKeepAlive(true, 5000);

    const connectTimer = setTimeout(() => {
      if (!settled && !tcpSocket.destroyed) {
        tcpSocket.destroy(new Error('Connection timeout'));
      }
    }, CONNECT_TIMEOUT);

    tcpSocket.on('connect', () => {
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
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
      console.error(`[proxy] TCP error (${targetHost}:${targetPort}):`, err.message);
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

  console.log(`[proxy] WebSocket proxy listening on ws://localhost:${port}`);
  return wss;
}

module.exports = { startWebSocketProxy };
