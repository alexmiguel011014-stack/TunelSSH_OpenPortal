import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'net';
import WebSocket from 'ws';

// GOALS 1's "Verification — proxy.js" item asks to confirm that two
// concurrent WS→TCP bridges on the same `wss` don't interfere — this proves
// exactly that against two local fake TCP targets, standing in for two real
// Tailscale hosts (which this environment doesn't have). What this can't
// cover is real network reachability across an actual tailnet — that part
// stays a manual check (see GOALS.md).
//
// net-guard.js's isDev flag is read once at module load, so NODE_ENV has to
// be set to 'development' *before* proxy.js/net-guard.js are first
// required in this file — done via a dynamic import in beforeAll rather
// than a static import, since static imports evaluate before any top-level
// code in this file would get a chance to set the env var first.
describe('startWebSocketProxy — concurrent bridges (integration)', () => {
  let startWebSocketProxy;
  let originalNodeEnv;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    vi.resetModules();
    ({ startWebSocketProxy } = await import('../proxy.js'));
  });

  afterAll(() => {
    // Nunca deixa NODE_ENV vazando pra outros arquivos de teste do mesmo
    // worker — net-guard.test.js depende de isDev=false pra sua asserção
    // "rejects localhost outside development mode".
    process.env.NODE_ENV = originalNodeEnv;
  });

  function startEchoServer(prefix) {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from(prefix), chunk])));
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  function connectWs(proxyPort, targetPort) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/?host=127.0.0.1&port=${targetPort}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function waitForMessage(ws) {
    return new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
  }

  it('bridges two concurrent connections to two different targets without cross-talk', async () => {
    const serverA = await startEchoServer('A:');
    const serverB = await startEchoServer('B:');
    const wss = startWebSocketProxy(0);
    await new Promise((resolve) => wss.once('listening', resolve));
    const proxyPort = wss.address().port;

    try {
      const wsA = await connectWs(proxyPort, serverA.address().port);
      const wsB = await connectWs(proxyPort, serverB.address().port);

      const replyA = waitForMessage(wsA);
      const replyB = waitForMessage(wsB);
      wsA.send('hello-a');
      wsB.send('hello-b');

      expect(await replyA).toBe('A:hello-a');
      expect(await replyB).toBe('B:hello-b');

      // Closing one bridge must not disturb the other, still-open one —
      // this is the actual property GOALS 1 needs proven (each connection's
      // tcpSocket/heartbeat state lives entirely inside its own
      // `wss.on('connection', ...)` closure, never shared).
      wsA.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(wsB.readyState).toBe(WebSocket.OPEN);

      const replyB2 = waitForMessage(wsB);
      wsB.send('still-alive');
      expect(await replyB2).toBe('B:still-alive');

      wsB.close();
    } finally {
      wss.close();
      serverA.close();
      serverB.close();
    }
  });
});
