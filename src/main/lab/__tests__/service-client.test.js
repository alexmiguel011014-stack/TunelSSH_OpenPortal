import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMANDS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PIPE_PATH,
  createServiceClient,
} from '../service-client.js';

// O pipe de verdade é \\.\pipe\OpenPortalLab; aqui um servidor de teste escuta num
// pipe com nome único (Windows) ou num socket Unix (outros sistemas) e o cliente
// é apontado para ele.
const servers = [];
const sockets = new Set();

function uniquePath() {
  const id = crypto.randomBytes(6).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\openportal-test-${id}`
    : path.join(os.tmpdir(), `openportal-test-${id}.sock`);
}

async function fakePipe(onConnection) {
  const pipePath = uniquePath();
  const server = net.createServer(onConnection);
  server.on('connection', (socket) => sockets.add(socket));
  servers.push(server);
  await new Promise((resolve) => server.listen(pipePath, resolve));
  return pipePath;
}

// Um serviço que responde uma linha por pedido, ecoando o id, como o de verdade.
function replying(makeBody, { split = false } = {}) {
  return (socket) => {
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk;
      if (!received.includes('\n')) return;
      const request = JSON.parse(received.split('\n')[0]);
      const line = `${JSON.stringify({ id: request.id, ...makeBody(request) })}\n`;
      if (split) {
        const half = Math.floor(line.length / 2);
        socket.write(line.slice(0, half));
        setTimeout(() => socket.end(line.slice(half)), 20);
      } else {
        socket.end(line);
      }
    });
  };
}

afterEach(async () => {
  // Conexões que o teste deixou abertas (um serviço mudo) seguram o close().
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  while (servers.length) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('service pipe client', () => {
  it('uses the documented pipe name and the same commands as the service', () => {
    expect(PIPE_PATH).toBe('\\\\.\\pipe\\OpenPortalLab');
    expect(COMMANDS).toEqual([
      'status',
      'disk-info',
      'student-create',
      'student-delete',
      'student-set-quota',
      'reserve',
      'extend',
      'end',
      'ensure-folder-access',
      'events',
    ]);
  });

  it('sends one JSON line and returns the answer without the id', async () => {
    let seen;
    const pipePath = await fakePipe(
      replying((request) => {
        seen = request;
        return { ok: true, state: 'free', studentCount: 2 };
      }),
    );
    const client = createServiceClient({ pipePath });
    expect(await client.status()).toEqual({
      ok: true,
      state: 'free',
      studentCount: 2,
    });
    expect(seen).toMatchObject({ cmd: 'status' });
    expect(typeof seen.id).toBe('string');
  });

  it('builds each command with exactly its fields', async () => {
    const seen = [];
    const pipePath = await fakePipe(
      replying((request) => {
        seen.push(request);
        return { ok: true };
      }),
    );
    const client = createServiceClient({ pipePath });
    await client.studentCreate({ label: 'Ana', quotaGb: 25, extra: 'x' });
    await client.studentDelete('ana');
    await client.studentSetQuota({ account: 'ana', quotaGb: 30 });
    await client.reserve({
      account: 'ana',
      startWithinMs: 60000,
      sessionMs: 300000,
    });
    await client.extend({ reservationId: 'abcdefgh12', addMs: 60000 });
    await client.end({ reservationId: 'abcdefgh12', reason: 'manager-ended' });
    await client.ensureFolderAccess('ana');
    await client.diskInfo({ reserveGb: 10 });
    const withoutIds = seen.map((request) => {
      const rest = { ...request };
      delete rest.id;
      return rest;
    });
    expect(withoutIds).toEqual([
      { cmd: 'student-create', label: 'Ana', quotaGb: 25 },
      { cmd: 'student-delete', account: 'ana' },
      { cmd: 'student-set-quota', account: 'ana', quotaGb: 30 },
      {
        cmd: 'reserve',
        account: 'ana',
        startWithinMs: 60000,
        sessionMs: 300000,
      },
      { cmd: 'extend', reservationId: 'abcdefgh12', addMs: 60000 },
      { cmd: 'end', reservationId: 'abcdefgh12', reason: 'manager-ended' },
      { cmd: 'ensure-folder-access', account: 'ana' },
      { cmd: 'disk-info', reserveGb: 10 },
    ]);
  });

  it('puts together an answer that arrives in pieces', async () => {
    const pipePath = await fakePipe(replying(() => ({ ok: true, state: 'free' }), { split: true }));
    const client = createServiceClient({ pipePath });
    expect(await client.status()).toEqual({ ok: true, state: 'free' });
  });

  it('passes a service error through untouched', async () => {
    const pipePath = await fakePipe(
      replying(() => ({
        ok: false,
        error: 'busy',
        message: 'O PC já está reservado',
        account: 'ana',
      })),
    );
    const client = createServiceClient({ pipePath });
    expect(
      await client.reserve({
        account: 'bia',
        startWithinMs: 60000,
        sessionMs: 300000,
      }),
    ).toEqual({
      ok: false,
      error: 'busy',
      message: 'O PC já está reservado',
      account: 'ana',
    });
  });

  it('reports "service-down" when the pipe does not exist', async () => {
    const client = createServiceClient({ pipePath: uniquePath() });
    const result = await client.status();
    expect(result).toMatchObject({ ok: false, error: 'service-down' });
    expect(result.message).toContain('não está rodando');
  });

  it.each([
    ['EACCES', 'unauthorized'],
    ['EPERM', 'unauthorized'],
    ['ECONNRESET', 'unreachable'],
  ])('maps a %s connection error to %s', async (code, expected) => {
    const createConnection = () => {
      const socket = new net.Socket();
      setImmediate(() => socket.emit('error', Object.assign(new Error(code), { code })));
      return socket;
    };
    const client = createServiceClient({ createConnection });
    expect(await client.status()).toMatchObject({ ok: false, error: expected });
  });

  it('does not connect at all for an unknown command or an oversize request', async () => {
    const createConnection = vi.fn();
    const client = createServiceClient({ createConnection });
    expect(await client.request('format-c')).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(
      await client.request('student-create', {
        label: 'x'.repeat(MAX_REQUEST_BYTES),
        quotaGb: 1,
      }),
    ).toMatchObject({ ok: false, error: 'bad-request' });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('times out when the service never answers', async () => {
    const pipePath = await fakePipe(() => {});
    const client = createServiceClient({ pipePath });
    const started = Date.now();
    expect(await client.status({ timeoutMs: 120 })).toMatchObject({
      ok: false,
      error: 'timeout',
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a closed connection without an answer', async () => {
    const pipePath = await fakePipe((socket) => socket.on('data', () => socket.end()));
    const client = createServiceClient({ pipePath });
    expect(await client.status()).toMatchObject({
      ok: false,
      error: 'unreachable',
    });
  });

  it('refuses a response over 256 KiB', async () => {
    const pipePath = await fakePipe(
      replying(() => ({
        ok: true,
        blob: 'x'.repeat(MAX_RESPONSE_BYTES + 100),
      })),
    );
    const client = createServiceClient({ pipePath });
    expect(await client.status()).toMatchObject({
      ok: false,
      error: 'bad-response',
    });
  });

  it.each([
    ['not JSON', () => 'oi\n'],
    ['an array', () => '[1]\n'],
    ['no ok flag', () => '{"state":"free"}\n'],
    ['another request id', () => '{"id":"outro","ok":true}\n'],
  ])('refuses %s as a response', async (_, makeLine) => {
    const pipePath = await fakePipe((socket) => socket.on('data', () => socket.end(makeLine())));
    const client = createServiceClient({ pipePath });
    expect(await client.status()).toMatchObject({
      ok: false,
      error: 'bad-response',
    });
  });
});
