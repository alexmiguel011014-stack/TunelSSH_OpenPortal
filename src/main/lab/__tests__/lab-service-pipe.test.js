import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceClient } from '../service-client.js';

// O pipe REAL do serviço (ACL, SID do chamador, linhas, assíncrono), com um Windows
// falso por baixo (`--pipe-test`): o cliente do app fala com ele de verdade. Nenhuma
// conta do Windows é criada. Pulado onde o .exe não está compilado.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const exe = ['Debug', 'Release']
  .map((config) => path.join(root, 'lab-service', 'bin', config, 'OpenPortalLabService.exe'))
  .filter((file) => existsSync(file))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const canRun = process.platform === 'win32' && Boolean(exe);

const running = [];

function startHarness(owner) {
  const name = `openportal-pipe-test-${crypto.randomBytes(5).toString('hex')}`;
  const child = spawn(exe, ['--pipe-test', name, owner], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.push(child);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('o pipe de teste não subiu em 10 s')), 10_000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`pipe de teste saiu com ${code}`)));
  });
  return { child, pipePath: `\\\\.\\pipe\\${name}`, ready };
}

afterEach(() => {
  while (running.length) {
    const child = running.pop();
    child.stdin.end();
    child.kill();
  }
});

describe.skipIf(!canRun)('lab service pipe (real pipe, fake Windows)', () => {
  it('answers the app client as the owner: students, reservation, hand-over, end', async () => {
    const { pipePath, ready } = startHarness('self');
    await ready;
    const client = createServiceClient({ pipePath });

    const status = await client.status();
    expect(status).toMatchObject({
      ok: true,
      state: 'free',
      studentCount: 0,
      quota: 'enforce',
    });

    const ana = await client.studentCreate({ label: 'Ana Souza', quotaGb: 25 });
    expect(ana).toMatchObject({
      ok: true,
      account: 'anasouza',
      state: 'free',
      quotaGb: 25,
    });
    const joao = await client.studentCreate({ label: 'João', quotaGb: 25 });
    expect(joao).toMatchObject({ ok: true, account: 'joao' });

    const reserved = await client.reserve({
      account: 'anasouza',
      startWithinMs: 30 * 60_000,
      sessionMs: 60 * 60_000,
    });
    expect(reserved).toMatchObject({
      ok: true,
      account: 'anasouza',
      userName: 'LABPC\\anasouza',
    });
    expect(reserved.password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(typeof reserved.reservationId).toBe('string');

    // Nunca dois: o segundo pedido volta "busy" dizendo quem está com o PC.
    const busy = await client.reserve({
      account: 'joao',
      startWithinMs: 30 * 60_000,
      sessionMs: 60 * 60_000,
    });
    expect(busy).toMatchObject({
      ok: false,
      error: 'busy',
      account: 'anasouza',
      label: 'Ana Souza',
    });

    const during = await client.status();
    expect(during).toMatchObject({
      ok: true,
      state: 'reserved',
      studentCount: 2,
    });
    expect(JSON.stringify(during)).not.toContain(reserved.password);
    expect(JSON.stringify(during)).not.toMatch(/password/i);

    const ended = await client.end({
      reservationId: reserved.reservationId,
      reason: 'manager-handover',
    });
    expect(ended).toMatchObject({ ok: true, ended: true });
    expect(await client.status()).toMatchObject({ ok: true, state: 'free' });

    const next = await client.reserve({
      account: 'joao',
      startWithinMs: 30 * 60_000,
      sessionMs: 60 * 60_000,
    });
    expect(next).toMatchObject({ ok: true, account: 'joao' });
    expect(next.password).not.toBe(reserved.password);
  });

  it('disk-info, quota change, folder access and delete go through the pipe', async () => {
    const { pipePath, ready } = startHarness('self');
    await ready;
    const client = createServiceClient({ pipePath });
    await client.studentCreate({ label: 'Ana', quotaGb: 25 });
    expect(await client.diskInfo({})).toMatchObject({
      ok: true,
      recommended: 5,
      reserveGb: 50,
      assignedGb: 25,
      status: 'ok',
      studentCount: 1,
    });
    expect(await client.studentSetQuota({ account: 'ana', quotaGb: 40 })).toMatchObject({
      ok: true,
      quotaGb: 40,
    });
    expect(await client.ensureFolderAccess('ana')).toMatchObject({ ok: true });
    expect(await client.studentDelete('ana')).toMatchObject({ ok: true });
    expect(await client.studentDelete('ana')).toMatchObject({
      ok: false,
      error: 'not-found',
    });
  });

  it('refuses malformed fields on the service side too', async () => {
    const { pipePath, ready } = startHarness('self');
    await ready;
    const client = createServiceClient({ pipePath });
    expect(
      await client.request('reserve', {
        account: 'ana',
        startWithinMs: 5,
        sessionMs: 5,
      }),
    ).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(await client.request('student-delete', { account: '..\\Administrator' })).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(await client.request('events', {})).toMatchObject({
      ok: false,
      error: 'unsupported',
    });
  });

  it('rejects a request over 4 KiB without a line break', async () => {
    const { pipePath, ready } = startHarness('self');
    await ready;
    const reply = await new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      let data = '';
      socket.on('connect', () => socket.write(`{"cmd":"status","pad":"${'x'.repeat(6000)}`));
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
      setTimeout(() => socket.destroy(), 8000);
    });
    expect(JSON.parse(reply.split('\n')[0])).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
  });

  it('serves many callers at once', async () => {
    const { pipePath, ready } = startHarness('self');
    await ready;
    const client = createServiceClient({ pipePath });
    const answers = await Promise.all(Array.from({ length: 20 }, () => client.status()));
    expect(answers.every((answer) => answer.ok === true)).toBe(true);
  });

  it('keeps an account other than the owner out of the pipe', async () => {
    // O dono configurado é outra conta: a ACL do pipe não deixa esta nem abrir.
    const { pipePath, ready } = startHarness('S-1-5-21-1111111111-2222222222-3333333333-1001');
    await ready;
    const client = createServiceClient({ pipePath });
    const answer = await client.status();
    expect(answer).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('stops by itself when its input closes', async () => {
    const { child, ready } = startHarness('self');
    await ready;
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.stdin.end();
    expect(await exited).toBe(0);
  });
});

describe.skipIf(!canRun)('lab service pipe harness safety', () => {
  it('never runs on the real service pipe name, and refuses odd names', async () => {
    for (const name of ['OpenPortalLab', 'a b', '..\\x', '']) {
      const child = spawn(exe, ['--pipe-test', name, 'self']);
      const code = await new Promise((resolve) => child.on('exit', resolve));
      expect(code).toBe(2);
    }
  });
});
