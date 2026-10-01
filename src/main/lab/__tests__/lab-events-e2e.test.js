import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRequestServer, sendActivityEvent } from '../../connection/connection-request.js';
import { FailureLimiter } from '../../connection/session-password.js';
import { createActivityReceiver } from '../activity-receiver.js';
import { sendLabRequest } from '../client.js';
import { createEventLog } from '../event-log.js';
import { groupReservations } from '../events.js';
import { createLabHost } from '../host.js';
import { createJournalFeed } from '../journal-feed.js';
import { createLabStore } from '../lab-store.js';
import { createLabManager } from '../manager.js';
import { createServiceClient } from '../service-client.js';
import { createServiceControl } from '../service-control.js';

// O registro central de acessos de ponta a ponta (GOALS 19): o PC B é de verdade (servidor da porta
// de sinalização, host `lab-*`, o executável do serviço com o diário de verdade, só o Windows é
// falso); o PC A é de verdade (gerente, registro, receptor de eventos). A rede é o loopback.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const exe = ['Debug', 'Release']
  .map((config) => path.join(root, 'lab-service', 'bin', config, 'OpenPortalLabService.exe'))
  .filter((file) => existsSync(file))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const canRun = process.platform === 'win32' && Boolean(exe);

const PROF = 'prof@escola.com';
const HOST_ID = 'host-b-uuid';
const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

function startHarness() {
  const name = `openportal-pipe-test-${crypto.randomBytes(5).toString('hex')}`;
  const child = spawn(exe, ['--pipe-test', name, 'self', '120'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanup.push(() => {
    child.stdin.end();
    child.kill();
  });
  const waiting = [];
  const lines = [];
  let buffer = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('o pipe de teste não subiu em 10 s')), 10_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (text === 'READY') {
          clearTimeout(timer);
          resolve();
        } else if (text) {
          const waiter = waiting.shift();
          if (waiter) waiter(text);
          else lines.push(text);
        }
      }
    });
    child.on('exit', (code) => reject(new Error(`pipe de teste saiu com ${code}`)));
  });
  const command = (line) =>
    new Promise((resolve) => {
      if (lines.length) resolve(lines.shift());
      else waiting.push(resolve);
      child.stdin.write(`${line}\n`);
    });
  return { pipePath: `\\\\.\\pipe\\${name}`, ready, command };
}

function memoryStore(initial = {}) {
  let disk = initial;
  return createLabStore({
    read: () => structuredClone(disk),
    write: (next) => {
      disk = structuredClone(next);
    },
    randomUUID: () => HOST_ID,
  });
}

async function listen(server) {
  server.start(0, { retryInUseMs: 0 });
  await new Promise((resolve) => server.server.once('listening', resolve));
  return server.server.address().port;
}

async function startPcB() {
  const harness = startHarness();
  await harness.ready;
  const service = createServiceClient({ pipePath: harness.pipePath });
  const control = createServiceControl({
    client: service,
    provisioning: { readServiceStatus: async () => 'Running' },
    serviceSource: exe,
    exists: () => true,
  });
  // O gerente já foi aceito neste PC (a matrícula é do GOALS 16).
  const store = memoryStore({ lab: { managers: [PROF] } });
  const host = createLabHost({
    resolveIdentity: async () => PROF,
    limiter: new FailureLimiter(),
    store,
    askEnrollment: vi.fn(async () => 'accepted'),
    info: { hostName: () => 'PC-B', appVersion: () => '1.0.8' },
    getStatusInput: () => control.hostStatusInput(),
    service,
    usersRoot: os.tmpdir(),
    log: () => {},
  });
  const server = new ConnectionRequestServer(vi.fn(), { labHandler: (args) => host.handle(args) });
  const port = await listen(server);
  cleanup.push(() => server.stop());
  return { harness, service, host, store, server, port };
}

// O PC A: o gerente com o registro, e o servidor que recebe os eventos empurrados.
async function startPcA(portB, { rosterHost = '127.0.0.1' } = {}) {
  const roster = [{ hostId: HOST_ID, name: 'PC-B', host: rosterHost, enrolledAt: 1 }];
  const store = memoryStore({ lab: { roster } });
  const eventLog = createEventLog({ now: () => Date.now() });
  const manager = createLabManager({
    store,
    eventLog,
    sendRequest: (_host, built, options) =>
      sendLabRequest('127.0.0.1', built, { ...options, port: portB }),
    isAllowedHost: () => true,
  });
  const dropped = [];
  const receiver = createActivityReceiver({
    getRoster: () => store.getLab().roster,
    getTrustedLogins: () => [],
    resolveIdentity: async () => 'unknown',
    eventLog,
    log: (line) => dropped.push(line),
  });
  const server = new ConnectionRequestServer(vi.fn());
  server.on('activity-event', (event, remoteAddress) => {
    receiver.receive({ event, remoteAddress }).catch(() => {});
  });
  const port = await listen(server);
  cleanup.push(() => server.stop());
  const poll = async () => {
    await manager.pollOnce();
    await manager.settled();
  };
  return { manager, eventLog, receiver, port, poll, dropped };
}

const when = { startWithinMs: 1_800_000, sessionMs: 3_600_000 };

describe.skipIf(!canRun)('lab access log end to end (GOALS 19)', () => {
  it('a reservation that ran while the manager app was closed shows up whole when it opens', async () => {
    const b = await startPcB();
    // O gerente ainda não está olhando: tudo acontece no PC B.
    expect((await b.service.studentCreate({ label: 'Ana Souza', quotaGb: 1 })).ok).toBe(true);
    const reserved = await b.service.reserve({ account: 'anasouza', ...when });
    const session = (await b.harness.command('signin anasouza 100.64.0.9')).split(' ')[1];
    await b.harness.command('tick');
    await b.harness.command('disconnect ' + session);
    await b.harness.command('reconnect ' + session);
    await b.harness.command('advance ' + 61 * 60_000);
    await b.harness.command('tick'); // o prazo acabou

    // Agora o gerente abre.
    const a = await startPcA(b.port);
    await a.poll();
    const { events } = a.eventLog.query({ hostId: HOST_ID });
    expect(events.map((event) => event.type)).toEqual([
      'student-added',
      'reservation-start',
      'session-logon',
      'session-logoff',
      'session-logon',
      'reservation-end',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(a.eventLog.cursor(HOST_ID)).toBe(6);

    const [reservation] = groupReservations(events);
    expect(reservation).toMatchObject({
      reservationId: reserved.reservationId,
      hostName: 'PC-B',
      student: { label: 'Ana Souza', account: 'anasouza' },
      endReason: 'deadline',
    });
    expect(reservation.startedAt).toBeGreaterThan(0);
    expect(reservation.endedAt).toBeGreaterThan(reservation.startedAt);
    expect(reservation.signIns.map((s) => [s.kind, s.detail, s.sourceIp])).toEqual([
      ['logon', 'logon', '100.64.0.9'],
      ['logoff', 'disconnect', '100.64.0.9'],
      ['logon', 'reconnect', '100.64.0.9'],
    ]);
    // Uma segunda consulta não repete nem pede mais nada.
    const before = a.eventLog.count();
    await a.poll();
    expect(a.eventLog.count()).toBe(before);
    // A senha do aluno não está em nenhum evento.
    expect(JSON.stringify(events)).not.toContain(reserved.password);
  });

  it('an event pushed live and the same event pulled later are stored once', async () => {
    const b = await startPcB();
    const a = await startPcA(b.port);
    const pushed = vi.fn((ip, event) => sendActivityEvent(ip, event, a.port));
    const feed = createJournalFeed({
      service: b.service,
      getTargets: async () => ['127.0.0.1'],
      push: pushed,
      hostIdentity: () => ({ hostId: HOST_ID, hostName: 'PC-B' }),
    });
    await feed.tick(); // posição inicial: o fim atual do diário
    await b.service.studentCreate({ label: 'Bia', quotaGb: 1 });
    await b.service.studentCreate({ label: 'Caio', quotaGb: 1 });
    await feed.tick();
    expect(pushed).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(a.eventLog.count()).toBe(2));
    expect(a.eventLog.query().events.map((e) => e.seq)).toEqual([1, 2]);

    // Agora a consulta periódica: o mesmo par (hostId, seq) não entra duas vezes.
    await a.poll();
    expect(a.eventLog.count()).toBe(2);
    expect(a.eventLog.cursor(HOST_ID)).toBe(2);
    expect(a.receiver.stats().dropped).toBe(0);
  });

  it('an event that skips ahead by push does not hide what came before it', async () => {
    const b = await startPcB();
    const a = await startPcA(b.port);
    await b.service.studentCreate({ label: 'Ana', quotaGb: 1 });
    await b.service.studentCreate({ label: 'Bia', quotaGb: 1 });
    await b.service.studentCreate({ label: 'Caio', quotaGb: 1 });
    // Só o terceiro foi empurrado (os outros dois se perderam).
    const third = (await b.service.events({ sinceSeq: 2, limit: 1 })).events[0];
    sendActivityEvent(
      '127.0.0.1',
      {
        v: 2,
        hostId: HOST_ID,
        hostName: 'PC-B',
        seq: third.seq,
        at: third.at,
        type: third.type,
        student: { label: third.label, account: third.account },
      },
      a.port,
    );
    await vi.waitFor(() => expect(a.eventLog.count()).toBe(1));
    expect(a.eventLog.cursor(HOST_ID)).toBe(0);
    await a.poll();
    expect(a.eventLog.query().events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(a.eventLog.cursor(HOST_ID)).toBe(3);
  });

  it('forged events are not stored: an address that is not in the roster, and another PC id', async () => {
    const b = await startPcB();
    // O PC B (127.0.0.1) NÃO está na lista do gerente: a lista tem outro endereço.
    const stranger = await startPcA(b.port, { rosterHost: '100.64.0.77' });
    const forged = {
      v: 2,
      hostId: HOST_ID,
      hostName: 'PC-B',
      seq: 1,
      at: Date.now(),
      type: 'reservation-end',
      endReason: 'deadline',
      student: { label: 'Ana', account: 'ana' },
    };
    sendActivityEvent('127.0.0.1', forged, stranger.port);
    await vi.waitFor(() => expect(stranger.receiver.stats().dropped).toBe(1));
    expect(stranger.eventLog.count()).toBe(0);
    expect(stranger.receiver.stats().reasons).toEqual({ 'not-in-roster': 1 });

    // O endereço é o de um PC da lista, mas o evento diz ser de outro PC.
    const roster = await startPcA(b.port);
    sendActivityEvent('127.0.0.1', { ...forged, hostId: 'outro-pc' }, roster.port);
    await vi.waitFor(() => expect(roster.receiver.stats().dropped).toBe(1));
    expect(roster.eventLog.count()).toBe(0);
    expect(roster.receiver.stats().reasons).toEqual({ 'host-mismatch': 1 });

    // Um evento de um GOALS 4 de quem ninguém conhece também não entra.
    sendActivityEvent(
      '127.0.0.1',
      {
        identity: 'x@y',
        machineName: 'PC',
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        filesTransferred: 0,
      },
      roster.port,
    );
    await vi.waitFor(() => expect(roster.receiver.stats().dropped).toBe(2));
    expect(roster.eventLog.count()).toBe(0);
  });

  it('records the manager changes (who was accepted or removed) in the same journal', async () => {
    const b = await startPcB();
    await b.host.note('manager-enrolled', PROF);
    await b.host.note('manager-removed', PROF);
    const a = await startPcA(b.port);
    await a.poll();
    expect(a.eventLog.query().events.map((e) => [e.type, e.detail])).toEqual([
      ['manager-enrolled', PROF],
      ['manager-removed', PROF],
    ]);
  });

  it('records host-lost when PC B stops answering during a reservation, and host-back when it returns', async () => {
    const b = await startPcB();
    await b.service.studentCreate({ label: 'Ana', quotaGb: 1 });
    await b.service.reserve({ account: 'ana', ...when });
    const a = await startPcA(b.port);
    await a.poll();
    expect(a.manager.snapshot()[0].state).toBe('reserved');

    // O app do PC B fecha no meio da reserva.
    b.server.stop();
    for (let i = 0; i < 3; i += 1) await a.poll();
    const lost = a.eventLog.query({ types: ['host-lost'] }).events;
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ hostName: 'PC-B', student: { label: 'Ana' } });
    expect(a.manager.snapshot()[0].lost).toBe(true);

    // E volta, na mesma porta.
    const reopened = new ConnectionRequestServer(vi.fn(), {
      labHandler: (args) => b.host.handle(args),
    });
    reopened.start(b.port, { retryInUseMs: 0 });
    await new Promise((resolve) => reopened.server.once('listening', resolve));
    cleanup.push(() => reopened.stop());
    await a.poll();
    expect(a.eventLog.query({ types: ['host-back'] }).events).toHaveLength(1);
    expect(a.manager.snapshot()[0].lost).toBeUndefined();
  });
});
