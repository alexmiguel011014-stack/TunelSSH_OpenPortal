import { describe, expect, it, vi } from 'vitest';
import { createLabStore } from '../lab-store.js';
import { createLabManager } from '../manager.js';
import { buildError, buildSuccess } from '../protocol.js';

// As ações do gerente sobre um PC (GOALS 18): alunos, reserva, troca de aluno e
// pasta. O PC é um roteiro: cada tipo de pedido devolve a próxima resposta da fila.

const PASSWORD = 'Qm7rXk2PzV9tHw4B';
const HOST_ID = 'host-1';
const ok = (response) => ({ ok: true, response });
const down = (error = 'unreachable') => ({ ok: false, error, message: 'x' });

const status = (extra = {}) =>
  ok(
    buildSuccess('lab-status', {
      hostId: HOST_ID,
      hostName: 'PC-LAB-01',
      appVersion: '1.0.8',
      managed: true,
      service: { installed: true, running: true },
      state: 'free',
      studentCount: 2,
      ...extra,
    }),
  );

const RESERVATION = {
  id: 'abcd1234abcd1234',
  account: 'ana',
  label: 'Ana Souza',
  state: 'in-use',
  startBy: 1000,
  endsAt: 9000,
  createdAt: 500,
  firstLogonAt: 800,
};

const studentsAnswer = (extra = {}) =>
  ok(
    buildSuccess('lab-students', {
      quota: 'enforce',
      students: [
        { account: 'ana', label: 'Ana Souza', quotaGb: 25, state: 'free', usedBytes: 0 },
        { account: 'joao', label: 'João', quotaGb: 25, state: 'free' },
      ],
      ...extra,
    }),
  );

const credentials = (account = 'joao', extra = {}) =>
  ok(
    buildSuccess('lab-reserve', {
      reservationId: 'ffff0000ffff0000',
      account,
      userName: `LABPC\\${account}`,
      password: PASSWORD,
      startBy: 2000,
      endsAt: 10000,
      ...extra,
    }),
  );

const failure = (type, error, message, extra) => ok(buildError(type, error, message, extra));

async function setup({ script = {}, pcState = 'free' } = {}) {
  const disk = {
    lab: { roster: [{ hostId: HOST_ID, name: 'PC-LAB-01', host: '100.64.0.11', enrolledAt: 1 }] },
  };
  const store = createLabStore({ read: () => structuredClone(disk), write: () => {} });
  const calls = [];
  const queues = Object.fromEntries(
    Object.entries(script).map(([type, answers]) => [type, [...answers]]),
  );
  const sendRequest = vi.fn(async (host, built, options) => {
    const { type } = built.request;
    if (type === 'lab-status') return status({ state: pcState });
    calls.push({ type, fields: { ...built.request }, options, host });
    const queue = queues[type];
    if (!queue || queue.length === 0) return down();
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next(built.request) : next;
  });
  const logs = [];
  const adopted = [];
  const manager = createLabManager({
    store,
    sendRequest,
    openFolder: async (host, built) => sendRequest(host, built, {}),
    adoptFileSession: (host, socket, options) => {
      adopted.push({ host, socket, options });
      return { sessionId: 'ft-1' };
    },
    isAllowedHost: () => true,
    log: (line) => logs.push(line),
  });
  await manager.pollOnce();
  return { manager, calls, sendRequest, logs, adopted, store };
}

const when = { account: 'joao', startWithinMs: 1_800_000, sessionMs: 3_600_000 };

describe('lab manager actions: when they may run', () => {
  it('refuses a PC that is not in the list, or has not answered, without sending anything', async () => {
    const { manager, sendRequest } = await setup();
    const actions = (mock) =>
      mock.mock.calls.filter(([, built]) => built.request.type !== 'lab-status').length;
    const before = actions(sendRequest);
    expect(await manager.reserve('nao-existe', when)).toMatchObject({
      ok: false,
      error: 'unknown-pc',
    });

    const offline = await setup({ script: {} });
    offline.sendRequest.mockImplementation(async () => down());
    // duas rodadas sem resposta = offline
    await offline.manager.pollOnce();
    await offline.manager.pollOnce();
    const sent = actions(offline.sendRequest);
    expect(await offline.manager.reserve(HOST_ID, when)).toMatchObject({
      ok: false,
      error: 'offline',
    });
    expect(await offline.manager.students(HOST_ID)).toMatchObject({ ok: false, error: 'offline' });
    expect(actions(offline.sendRequest)).toBe(sent);
    expect(actions(sendRequest)).toBe(before);
  });

  it('validates the request before sending (a bad name or quota never leaves the app)', async () => {
    const { manager, calls } = await setup();
    expect(await manager.addStudent(HOST_ID, { label: '', quotaGb: 25 })).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(await manager.addStudent(HOST_ID, { label: 'Ana', quotaGb: 5000 })).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(await manager.reserve(HOST_ID, { ...when, sessionMs: 1000 })).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(calls).toEqual([]);
  });
});

describe('lab manager actions: students', () => {
  it('lists the students with the reservation and capacity, and creates, resizes and deletes', async () => {
    const { manager, calls } = await setup({
      script: {
        'lab-students': [
          studentsAnswer({
            reservation: RESERVATION,
            capacity: {
              totalGb: 250,
              freeGb: 120,
              reserveGb: 50,
              quotaGb: 25,
              recommended: 2,
              assignedGb: 50,
              status: 'ok',
            },
          }),
        ],
        'lab-student-add': [
          ok(
            buildSuccess('lab-student-add', {
              student: { account: 'bia', label: 'Bia', quotaGb: 20, state: 'free' },
            }),
          ),
        ],
        'lab-student-quota': [
          ok(
            buildSuccess('lab-student-quota', {
              student: { account: 'ana', label: 'Ana Souza', quotaGb: 40, state: 'free' },
            }),
          ),
        ],
        'lab-student-delete': [ok(buildSuccess('lab-student-delete', { account: 'ana' }))],
      },
    });
    const listed = await manager.students(HOST_ID);
    expect(listed).toMatchObject({
      ok: true,
      quota: 'enforce',
      reservation: { id: 'abcd1234abcd1234', account: 'ana', state: 'in-use' },
      capacity: { recommended: 2, status: 'ok' },
    });
    expect(listed.students.map((s) => s.account)).toEqual(['ana', 'joao']);

    expect(await manager.addStudent(HOST_ID, { label: ' Bia ', quotaGb: 20 })).toMatchObject({
      ok: true,
      student: { account: 'bia', quotaGb: 20 },
    });
    expect(await manager.setQuota(HOST_ID, { account: 'ana', quotaGb: 40 })).toMatchObject({
      ok: true,
      student: { account: 'ana', quotaGb: 40 },
    });
    expect(await manager.deleteStudent(HOST_ID, 'ana')).toEqual({ ok: true, account: 'ana' });
    expect(calls.map((c) => c.type)).toEqual([
      'lab-students',
      'lab-student-add',
      'lab-student-quota',
      'lab-student-delete',
    ]);
    // Criar e apagar levam bem mais que uma consulta.
    expect(calls[1].options.timeoutMs).toBeGreaterThan(30_000);
    expect(calls[3].options.timeoutMs).toBeGreaterThan(60_000);
  });

  it('shows why a student could not be deleted or added', async () => {
    const { manager } = await setup({
      script: {
        'lab-student-delete': [
          failure(
            'lab-student-delete',
            'busy',
            'Esse aluno está com o PC reservado; encerre a reserva antes',
          ),
        ],
        'lab-student-add': [failure('lab-student-add', 'full', 'Este PC já tem 100 alunos')],
        'lab-students': [failure('lab-students', 'service-down', 'x')],
      },
    });
    expect(await manager.deleteStudent(HOST_ID, 'ana')).toMatchObject({
      ok: false,
      error: 'busy',
      message: 'Esse aluno está com o PC reservado; encerre a reserva antes',
    });
    expect(await manager.addStudent(HOST_ID, { label: 'Bia', quotaGb: 20 })).toMatchObject({
      ok: false,
      error: 'full',
    });
    expect((await manager.students(HOST_ID)).message).toMatch(/serviço do laboratório/);
  });
});

describe('lab manager actions: reserving', () => {
  it('hands the credentials to the caller once, and keeps no copy', async () => {
    const { manager, logs, store } = await setup({ script: { 'lab-reserve': [credentials()] } });
    const result = await manager.reserve(HOST_ID, when);
    expect(result).toMatchObject({
      ok: true,
      credentials: { account: 'joao', userName: 'LABPC\\joao', password: PASSWORD, endsAt: 10000 },
      pc: { hostId: HOST_ID, name: 'PC-LAB-01', host: '100.64.0.11' },
    });
    expect(JSON.stringify(manager.snapshot())).not.toContain(PASSWORD);
    expect(JSON.stringify(store.getLab())).not.toContain(PASSWORD);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(PASSWORD);
    // Uma reserva nova no mesmo PC mostra a mesma coisa: nada ficou guardado.
    expect(JSON.stringify(await manager.students(HOST_ID))).not.toContain(PASSWORD);
  });

  it('says who has the PC and until when when it is busy', async () => {
    const { manager } = await setup({
      script: {
        'lab-reserve': [
          failure('lab-reserve', 'busy', 'O PC já está reservado', {
            busyWith: { account: 'ana', label: 'Ana Souza', state: 'in-use', endsAt: 9000 },
          }),
        ],
      },
    });
    expect(await manager.reserve(HOST_ID, when)).toMatchObject({
      ok: false,
      error: 'busy',
      busyWith: { label: 'Ana Souza', state: 'in-use', endsAt: 9000 },
    });
  });

  it('refuses credentials that do not look like credentials', async () => {
    for (const bad of [
      { password: 'curta' },
      { password: 'tem espaço nela 123' },
      { userName: '' },
    ]) {
      const { manager } = await setup({ script: { 'lab-reserve': [credentials('joao', bad)] } });
      expect(await manager.reserve(HOST_ID, when)).toMatchObject({
        ok: false,
        error: 'bad-response',
      });
    }
  });

  it('does not send two reservations at the same time for one PC', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { manager, calls } = await setup({
      script: {
        'lab-reserve': [
          async () => {
            await gate;
            return credentials();
          },
        ],
      },
    });
    const first = manager.reserve(HOST_ID, when);
    const second = await manager.reserve(HOST_ID, when);
    expect(second).toMatchObject({ ok: false, error: 'busy' });
    release();
    expect((await first).ok).toBe(true);
    expect(calls.filter((c) => c.type === 'lab-reserve')).toHaveLength(1);
  });

  it('extends a reservation and ends it with the reason it was given', async () => {
    const { manager, calls } = await setup({
      script: {
        'lab-extend': [
          ok(buildSuccess('lab-extend', { reservationId: 'abcd1234abcd1234', endsAt: 12000 })),
        ],
        'lab-end': [ok(buildSuccess('lab-end', { ended: true, reason: 'manager-ended' }))],
      },
    });
    expect(
      await manager.extend(HOST_ID, { reservationId: 'abcd1234abcd1234', addMs: 600_000 }),
    ).toMatchObject({ ok: true, reservationId: 'abcd1234abcd1234', endsAt: 12000 });
    expect(await manager.end(HOST_ID, { reservationId: 'abcd1234abcd1234' })).toMatchObject({
      ok: true,
    });
    expect(calls[1].fields).toMatchObject({ reason: 'manager-ended' });
    expect(calls[1].options.timeoutMs).toBeGreaterThanOrEqual(90_000);
  });
});

describe('lab manager actions: hand-over ("Trocar aluno")', () => {
  it('ends the active session first and reserves for the next student only afterwards', async () => {
    const { manager, calls } = await setup({
      pcState: 'in-use',
      script: {
        'lab-students': [studentsAnswer({ reservation: RESERVATION })],
        'lab-end': [ok(buildSuccess('lab-end', { ended: true, reason: 'manager-handover' }))],
        'lab-reserve': [credentials('joao')],
      },
    });
    const result = await manager.handOver(HOST_ID, when);
    expect(calls.map((c) => c.type)).toEqual(['lab-students', 'lab-end', 'lab-reserve']);
    expect(calls[1].fields).toMatchObject({
      reservationId: 'abcd1234abcd1234',
      reason: 'manager-handover',
    });
    expect(calls[2].fields).toMatchObject({ account: 'joao' });
    expect(result).toMatchObject({
      ok: true,
      credentials: { account: 'joao', password: PASSWORD },
      previous: { account: 'ana', label: 'Ana Souza' },
    });
  });

  it('does not reserve when the logoff failed, and tells the manager why', async () => {
    const { manager, calls } = await setup({
      pcState: 'in-use',
      script: {
        'lab-students': [studentsAnswer({ reservation: RESERVATION })],
        'lab-end': [failure('lab-end', 'logoff-failed', 'Não consegui encerrar a sessão do aluno')],
        'lab-reserve': [credentials('joao')],
      },
    });
    const result = await manager.handOver(HOST_ID, when);
    expect(result).toMatchObject({ ok: false, error: 'logoff-failed', step: 'end' });
    expect(result.message).toMatch(/Nada foi reservado/);
    expect(calls.map((c) => c.type)).toEqual(['lab-students', 'lab-end']);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('does not reserve when the PC cannot be reached to end the session', async () => {
    const { manager, calls } = await setup({
      pcState: 'in-use',
      script: {
        'lab-students': [studentsAnswer({ reservation: RESERVATION })],
        'lab-end': [{ ok: false, error: 'timeout', message: 'x' }],
        'lab-reserve': [credentials('joao')],
      },
    });
    expect(await manager.handOver(HOST_ID, when)).toMatchObject({
      ok: false,
      error: 'timeout',
      step: 'end',
    });
    expect(calls.some((c) => c.type === 'lab-reserve')).toBe(false);
  });

  it('skips the end when the PC is free, and carries on when the reservation vanished', async () => {
    const free = await setup({
      script: { 'lab-students': [studentsAnswer()], 'lab-reserve': [credentials('joao')] },
    });
    expect(await free.manager.handOver(HOST_ID, when)).toMatchObject({
      ok: true,
      previous: null,
    });
    expect(free.calls.map((c) => c.type)).toEqual(['lab-students', 'lab-reserve']);

    const vanished = await setup({
      pcState: 'in-use',
      script: {
        'lab-students': [studentsAnswer({ reservation: RESERVATION })],
        'lab-end': [failure('lab-end', 'not-found', 'Reserva não encontrada')],
        'lab-reserve': [credentials('joao')],
      },
    });
    expect((await vanished.manager.handOver(HOST_ID, when)).ok).toBe(true);
  });

  it('reports that the old session ended but somebody else took the PC in the meantime', async () => {
    const { manager } = await setup({
      pcState: 'in-use',
      script: {
        'lab-students': [studentsAnswer({ reservation: RESERVATION })],
        'lab-end': [ok(buildSuccess('lab-end', { ended: true }))],
        'lab-reserve': [
          failure('lab-reserve', 'busy', 'O PC já está reservado', {
            busyWith: { account: 'bia', label: 'Bia', state: 'reserved', endsAt: 9500 },
          }),
        ],
      },
    });
    expect(await manager.handOver(HOST_ID, when)).toMatchObject({
      ok: false,
      error: 'busy',
      step: 'reserve',
      ended: true,
      busyWith: { label: 'Bia' },
    });
  });
});

describe('lab manager actions: the read-only folder', () => {
  it('adopts the opened connection as a read-only file session', async () => {
    const socket = { destroy: vi.fn() };
    const { manager, adopted } = await setup({
      script: {
        'lab-folder': [
          {
            ok: true,
            response: buildSuccess('lab-folder', { account: 'ana', label: 'Ana Souza' }),
            socket,
          },
        ],
      },
    });
    expect(await manager.openFolder(HOST_ID, 'ana')).toEqual({
      ok: true,
      sessionId: 'ft-1',
      host: '100.64.0.11',
      pcName: 'PC-LAB-01',
      account: 'ana',
      label: 'Ana Souza',
    });
    expect(adopted).toEqual([{ host: '100.64.0.11', socket, options: { readOnly: true } }]);
  });

  it('adopts nothing when the PC refuses', async () => {
    const { manager, adopted } = await setup({
      script: { 'lab-folder': [failure('lab-folder', 'not-found', 'Aluno não encontrado')] },
    });
    expect(await manager.openFolder(HOST_ID, 'zed')).toMatchObject({
      ok: false,
      error: 'not-found',
    });
    expect(adopted).toEqual([]);
  });

  it('closes the connection of a PC that speaks another protocol version', async () => {
    const socket = { destroy: vi.fn() };
    const { manager, adopted } = await setup({
      script: {
        'lab-folder': [
          {
            ok: true,
            response: { ...buildSuccess('lab-folder', { account: 'ana' }), labProtocol: 2 },
            socket,
          },
        ],
      },
    });
    expect(await manager.openFolder(HOST_ID, 'ana')).toMatchObject({ ok: false });
    expect(socket.destroy).toHaveBeenCalled();
    expect(adopted).toEqual([]);
  });
});
