import net from 'net';
import { describe, it, expect, vi } from 'vitest';
import { ConnectionRequestServer } from '../connection-request.js';

// GOALS 16: as mensagens `lab-*` entram pela mesma porta do connect-request. O
// servidor real, numa porta efêmera de loopback, só entrega o pedido cru ao
// labHandler com o endereço real do socket e devolve a resposta.
function startServer(options) {
  return new Promise((resolve) => {
    const server = new ConnectionRequestServer(vi.fn(), options);
    server.start(0);
    server.server.once('listening', () => resolve(server));
  });
}

function exchange(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const chunks = [];
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

describe('ConnectionRequestServer: lab-* messages', () => {
  it('hands the raw request and the real socket address to labHandler and relays the answer', async () => {
    const labHandler = vi.fn(async () => ({
      type: 'lab-response',
      request: 'lab-status',
      ok: true,
      labProtocol: 1,
    }));
    const server = await startServer({ labHandler });
    try {
      const text = JSON.stringify({
        type: 'lab-status',
        labProtocol: 1,
        fromName: 'forjado',
      });
      const body = await exchange(server.server.address().port, text);
      expect(JSON.parse(body)).toMatchObject({
        type: 'lab-response',
        ok: true,
      });
      expect(labHandler).toHaveBeenCalledTimes(1);
      const [{ input, remoteAddress, signal }] = labHandler.mock.calls[0];
      expect(Buffer.isBuffer(input) ? input.toString('utf8') : input).toBe(text);
      expect(remoteAddress).toMatch(/127\.0\.0\.1$/);
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      server.stop();
    }
  });

  it('never reaches onRequest for a lab message', async () => {
    const onRequest = vi.fn();
    const server = await new Promise((resolve) => {
      const instance = new ConnectionRequestServer(onRequest, {
        labHandler: async () => ({ type: 'lab-response', ok: true }),
      });
      instance.start(0);
      instance.server.once('listening', () => resolve(instance));
    });
    try {
      await exchange(
        server.server.address().port,
        JSON.stringify({ type: 'lab-status', labProtocol: 1 }),
      );
      expect(onRequest).not.toHaveBeenCalled();
    } finally {
      server.stop();
    }
  });

  it('answers unsupported when the app has no lab handler', async () => {
    const server = await startServer({});
    try {
      const body = await exchange(
        server.server.address().port,
        JSON.stringify({ type: 'lab-status', labProtocol: 1 }),
      );
      expect(JSON.parse(body)).toMatchObject({
        ok: false,
        error: 'unsupported',
      });
    } finally {
      server.stop();
    }
  });

  it('answers internal, without details, when the handler throws', async () => {
    const server = await startServer({
      labHandler: async () => {
        throw new Error('segredo do erro');
      },
    });
    try {
      const body = await exchange(
        server.server.address().port,
        JSON.stringify({ type: 'lab-status', labProtocol: 1 }),
      );
      expect(JSON.parse(body)).toMatchObject({ ok: false, error: 'internal' });
      expect(body).not.toContain('segredo');
    } finally {
      server.stop();
    }
  });

  it('closes without answering when the handler has nobody to answer', async () => {
    const server = await startServer({ labHandler: async () => null });
    try {
      const body = await exchange(
        server.server.address().port,
        JSON.stringify({ type: 'lab-status', labProtocol: 1 }),
      );
      expect(body).toBe('');
    } finally {
      server.stop();
    }
  });

  it('aborts the signal when the asker disconnects before the answer', async () => {
    let seenSignal;
    let finish;
    const server = await startServer({
      labHandler: ({ signal }) => {
        seenSignal = signal;
        return new Promise((resolve) => (finish = resolve));
      },
    });
    try {
      const socket = net.createConnection(server.server.address().port, '127.0.0.1');
      await new Promise((resolve) => socket.on('connect', resolve));
      socket.write(JSON.stringify({ type: 'lab-enroll', labProtocol: 1 }));
      await vi.waitFor(() => expect(seenSignal).toBeDefined());
      expect(seenSignal.aborted).toBe(false);
      socket.destroy();
      await vi.waitFor(() => expect(seenSignal.aborted).toBe(true));
      finish(null);
    } finally {
      server.stop();
    }
  });

  it('drops a connection that sends 64 KiB without a complete JSON object', async () => {
    const server = await startServer({ labHandler: vi.fn() });
    try {
      const body = await exchange(
        server.server.address().port,
        `{"type":"lab-status",${'x'.repeat(70 * 1024)}`,
      );
      expect(body).toBe('');
    } finally {
      server.stop();
    }
  });

  it('still routes a non-lab message the old way', async () => {
    const server = await startServer({ labHandler: vi.fn() });
    try {
      const body = await exchange(
        server.server.address().port,
        JSON.stringify({ type: 'mystery' }),
      );
      expect(JSON.parse(body)).toMatchObject({
        type: 'connect-response',
        approved: false,
      });
    } finally {
      server.stop();
    }
  });
});
