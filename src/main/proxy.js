const WebSocket = require('ws');
const net = require('net');
const { URL } = require('url');

const isDev = process.env.NODE_ENV === 'development';

function startWebSocketProxy(port = 18900) {
  const wss = new WebSocket.Server({ port });

  wss.on('connection', (ws, req) => {
    let tcpSocket = null;

    const url = new URL(req.url, 'http://localhost');
    const targetHost = url.searchParams.get('host');
    const targetPort = parseInt(url.searchParams.get('port') || '5900', 10);

    if (!targetHost) {
      ws.close(4001, 'Missing host parameter');
      return;
    }

    if (!targetHost.startsWith('100.') && !(isDev && targetHost === '127.0.0.1')) {
      ws.close(4002, 'Invalid host: must be Tailscale IP (100.x.x.x)');
      return;
    }

    tcpSocket = net.createConnection(targetPort, targetHost);

    tcpSocket.setNoDelay(true);
    tcpSocket.setKeepAlive(true, 5000);

    tcpSocket.on('connect', () => {
      // TCP connected — noVNC will start VNC handshake
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
      console.error(`[proxy] TCP error (${targetHost}:${targetPort}):`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4003, `TCP error: ${err.message}`);
      }
    });

    tcpSocket.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'TCP closed');
      }
    });

    ws.on('close', () => {
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.destroy();
      }
    });

    ws.on('error', () => {
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.destroy();
      }
    });
  });

  console.log(`[proxy] WebSocket proxy listening on ws://localhost:${port}`);
  return wss;
}

module.exports = { startWebSocketProxy };
