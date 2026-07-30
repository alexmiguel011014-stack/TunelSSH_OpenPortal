const WebSocket = require('ws');
const net = require('net');

const isDev = process.env.NODE_ENV === 'development';

function startFileProxy(port = 18901) {
  const wss = new WebSocket.Server({ port });

  wss.on('connection', (ws, req) => {
    let tcpSocket = null;

    const url = new URL(req.url, 'http://localhost');
    const targetHost = url.searchParams.get('host');
    const targetPort = parseInt(url.searchParams.get('port') || '5001', 10);

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

    tcpSocket.on('connect', () => {});

    tcpSocket.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    });

    ws.on('message', (data) => {
      if (tcpSocket && !tcpSocket.destroyed) {
        tcpSocket.write(Buffer.from(data));
      }
    });

    tcpSocket.on('error', (err) => {
      console.error(`[file-proxy] TCP error (${targetHost}:${targetPort}):`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4003, 'TCP error');
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

  console.log(`[file-proxy] File WebSocket proxy listening on ws://localhost:${port}`);
  return wss;
}

module.exports = { startFileProxy };
