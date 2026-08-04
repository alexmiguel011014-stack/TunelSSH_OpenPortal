const WebSocket = require('ws');
const net = require('net');
const { URL } = require('url');

const isDev = process.env.NODE_ENV === 'development';

const CONNECT_TIMEOUT = 10000;
const IDLE_TIMEOUT = 30 * 60 * 1000;

function isAllowedHost(host) {
  if (!host) return false;
  if (host.startsWith('100.')) return true;
  if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.')) return true;
  if (isDev && (host === '127.0.0.1' || host === 'localhost')) return true;
  return false;
}

function startWebSocketProxy(port = 18900) {
  const wss = new WebSocket.Server({ port });

  wss.on('connection', (ws, req) => {
    let tcpSocket = null;
    let settled = false;

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
    });

    tcpSocket.on('timeout', () => {
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
      clearTimeout(connectTimer);
      console.error(`[proxy] TCP error (${targetHost}:${targetPort}):`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4003, `TCP error: ${err.message}`);
      }
    });

    tcpSocket.on('close', () => {
      clearTimeout(connectTimer);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'TCP closed');
      }
    });

    ws.on('close', () => {
      clearTimeout(connectTimer);
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.destroy();
      }
    });

    ws.on('error', () => {
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
