import { describe, expect, it, vi } from 'vitest';
import { FailureLimiter } from '../../connection/session-password.js';
import { createLabHost } from '../host.js';
import { createLabStore } from '../lab-store.js';
import { FILE_SESSION, LAB_PROTOCOL, serializeResponse } from '../protocol.js';

const PROF = 'prof@escola.com';
const MANAGER_IP = '100.64.0.10';
const STRANGER_IP = '100.64.0.20';
const PASSWORD = 'Qm7rXk2PzV9tHw4B';

const message = (type, fields = {}) =>
  JSON.stringify({ type, labProtocol: LAB_PROTOCOL, ...fields });

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

function fakeService(overrides = {}) {
  return {
    status: vi.fn(async () => ({
      ok: true,
      state: 'free',
      studentCount: 2,
      quota: 'enforce',
      students: [
        {
          account: 'ana',
          label: 'Ana Souza',
          quotaGb: 25,
          state: 'free',
          lastSessionEnd: 700,
          usedBytes: 4.2 * 1024 ** 3,
        },
        { account: 'joao', label: 'João', quotaGb: 25, state: 'free', lastSessionEnd: 0 },
      ],
      disk: { totalGb: 250, freeGb: 120, usedByStudentsGb: 4.2 },
    })),
    diskInfo: vi.fn(async () => ({
      ok: true,
      totalGb: 250,
      freeGb: 120,
      reserveGb: 50,
      quotaGb: 25,
      recommended: 2,
      assignedGb: 50,
      usedByStudentsGb: 4.2,
      studentCount: 2,
      status: 'ok',
    })),
    studentCreate: vi.fn(async ({ label, quotaGb }) => ({
      ok: true,
      account: 'bia',
      label,
      quotaGb,
      state: 'free',
      lastSessionEnd: 0,
    })),
    studentSetQuota: vi.fn(async ({ account, quotaGb }) => ({
      ok: true,
      account,
      label: 'Ana Souza',
      quotaGb,
      state: 'free',
      lastSessionEnd: 0,
    })),
    studentDelete: vi.fn(async (account) => ({ ok: true, account })),
    reserve: vi.fn(async ({ account }) => ({
      ok: true,
      reservationId: 'abcd1234abcd1234',
      account,
      userName: `LABPC\\${account}`,
      password: PASSWORD,
      startBy: 1000,
      endsAt: 9000,
    })),
    extend: vi.fn(async ({ reservationId }) => ({ ok: true, reservationId, endsAt: 12000 })),
    end: vi.fn(async () => ({ ok: true, ended: true, reason: 'manager-ended' })),
    ensureFolderAccess: vi.fn(async (account) => ({
      ok: true,
      account,
      path: `C:\\Users\\${account}`,
    })),
    ...overrides,
  };
}

function setup({ service = fakeService(), withService = true } = {}) {
  let disk = { lab: { managers: [PROF] } };
  const store = createLabStore({
    read: () => structuredClone(disk),
    write: (next) => {
      disk = structuredClone(next);
    },
    randomUUID: () => 'host-uuid-1',
  });
  const logs = [];
  const clock = { t: 1_000_000 };
  const host = createLabHost({
    resolveIdentity: async (ip) => ({ [MANAGER_IP]: PROF, [STRANGER_IP]: 'aluno@escola.com' })[ip],
    limiter: new FailureLimiter({ now: () => clock.t }),
    store,
    askEnrollment: async () => 'rejected',
    info: { hostName: () => 'PC-LAB-01', appVersion: () => '1.0.8' },
    getStatusInput: () => ({ state: 'free', studentCount: 2 }),
    service: withService ? service : null,
    usersRoot: 'C:\\Users',
    log: (line) => logs.push(line),
    now: () => clock.t,
  });
  const ask = (input, ip = MANAGER_IP) => host.handle({ input, remoteAddress: ip });
  return { host, ask, service, logs };
}

describe('lab host (GOALS 18): who may use the student messages', () => {
  const requests = [
    message('lab-students'),
    message('lab-student-add', { label: 'Bia', quotaGb: 25 }),
    message('lab-student-quota', { account: 'ana', quotaGb: 30 }),
    message('lab-student-delete', { account: 'ana' }),
    message('lab-reserve', { account: 'ana', startWithinMs: 1_800_000, sessionMs: 3_600_000 }),
    message('lab-extend', { reservationId: 'abcd1234abcd1234', addMs: 600_000 }),
    message('lab-end', { reservationId: 'abcd1234abcd1234', reason: 'manager-ended' }),
    message('lab-folder', { account: 'ana' }),
  ];

  it('refuses every one of them from a login that is not a manager, and never touches the service', async () => {
    // Um PC novo por pedido: o bloqueio do IP (5 recusas) não entra na conta.
    for (const request of requests) {
      const { ask, service } = setup();
      expect(await ask(request, STRANGER_IP)).toMatchObject({ ok: false, error: 'unauthorized' });
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('refuses an address Tailscale cannot identify', async () => {
    const { ask, service } = setup();
    expect(await ask(requests[4], '100.64.0.99')).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
    expect(service.reserve).not.toHaveBeenCalled();
  });

  it('counts the refusals and locks the address after five', async () => {
    const { ask } = setup();
    let last;
    for (let i = 0; i < 5; i += 1) last = await ask(requests[4], STRANGER_IP);
    expect(last.error).toBe('locked');
  });

  it('answers service-down when this build has no service at all', async () => {
    const { ask } = setup({ withService: false });
    expect(await ask(requests[0])).toMatchObject({ ok: false, error: 'service-down' });
  });
});

describe('lab host (GOALS 18): validation before the service', () => {
  it.each([
    ['empty name', 'lab-student-add', { label: '   ', quotaGb: 25 }],
    ['name over 40 characters', 'lab-student-add', { label: 'x'.repeat(41), quotaGb: 25 }],
    ['name with a control character', 'lab-student-add', { label: 'Ana\u0007', quotaGb: 25 }],
    ['quota 0', 'lab-student-add', { label: 'Ana', quotaGb: 0 }],
    ['quota 2001', 'lab-student-quota', { account: 'ana', quotaGb: 2001 }],
    ['fractional quota', 'lab-student-quota', { account: 'ana', quotaGb: 2.5 }],
    ['account with a path', 'lab-student-delete', { account: '..\\Administrator' }],
    ['account in capitals', 'lab-folder', { account: 'Ana' }],
    [
      'validity under 5 minutes',
      'lab-reserve',
      { account: 'ana', startWithinMs: 60_000, sessionMs: 1000 },
    ],
    [
      'validity over 12 hours',
      'lab-reserve',
      { account: 'ana', startWithinMs: 60_000, sessionMs: 13 * 3_600_000 },
    ],
    [
      'start window over 24 hours',
      'lab-reserve',
      { account: 'ana', startWithinMs: 25 * 3_600_000, sessionMs: 3_600_000 },
    ],
    ['extension of 0', 'lab-extend', { reservationId: 'abcd1234abcd1234', addMs: 0 }],
    ['id with a slash', 'lab-extend', { reservationId: '../../etc/x', addMs: 600_000 }],
    ['made-up end reason', 'lab-end', { reservationId: 'abcd1234abcd1234', reason: 'deadline' }],
  ])('rejects %s', async (_name, type, fields) => {
    const { ask, service } = setup();
    expect(await ask(message(type, fields))).toMatchObject({ ok: false, error: 'bad-request' });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('trims the display name and passes only the fields it knows', async () => {
    const { ask, service } = setup();
    await ask(message('lab-student-add', { label: '  Bia Lima  ', quotaGb: 30, evil: '; rm' }));
    expect(service.studentCreate).toHaveBeenCalledWith(
      { label: 'Bia Lima', quotaGb: 30 },
      expect.anything(),
    );
  });
});

describe('lab host (GOALS 18): students and capacity', () => {
  it('lists the students with used space in GB, the reservation and the capacity box', async () => {
    const service = fakeService();
    service.status.mockResolvedValue({
      ...(await fakeService().status()),
      state: 'in-use',
      reservation: RESERVATION,
    });
    const { ask } = setup({ service });
    const response = await ask(message('lab-students'));
    expect(response).toMatchObject({
      ok: true,
      request: 'lab-students',
      quota: 'enforce',
      reservation: { id: 'abcd1234abcd1234', account: 'ana', state: 'in-use', endsAt: 9000 },
      capacity: { totalGb: 250, freeGb: 120, reserveGb: 50, recommended: 2, status: 'ok' },
    });
    expect(response.students).toEqual([
      {
        account: 'ana',
        label: 'Ana Souza',
        quotaGb: 25,
        state: 'free',
        lastSessionEnd: 700,
        usedGb: 4.2,
      },
      { account: 'joao', label: 'João', quotaGb: 25, state: 'free', lastSessionEnd: 0 },
    ]);
  });

  it('still lists the students when the disk cannot be read', async () => {
    const service = fakeService({
      diskInfo: vi.fn(async () => ({ ok: false, error: 'internal' })),
    });
    const { ask } = setup({ service });
    const response = await ask(message('lab-students'));
    expect(response.ok).toBe(true);
    expect(response).not.toHaveProperty('capacity');
    expect(response.students).toHaveLength(2);
  });

  it('says service-down when the pipe does not answer, without leaking why', async () => {
    const service = fakeService({
      status: vi.fn(async () => ({ ok: false, error: 'service-down', message: 'pipe' })),
    });
    const { ask } = setup({ service });
    expect(await ask(message('lab-students'))).toMatchObject({
      ok: false,
      error: 'service-down',
    });
  });

  it('drops fields the service was not asked for (a student record never carries a password)', async () => {
    const service = fakeService();
    const base = await service.status();
    service.status.mockResolvedValue({
      ...base,
      students: [{ ...base.students[0], password: 'S3cret', sid: 'S-1-5-21' }],
    });
    const { ask } = setup({ service });
    const body = JSON.stringify(await ask(message('lab-students')));
    expect(body).not.toMatch(/S3cret|S-1-5-21|password/);
  });

  it('adds a student, changes a quota and deletes one', async () => {
    const { ask, service } = setup();
    expect(await ask(message('lab-student-add', { label: 'Bia', quotaGb: 20 }))).toMatchObject({
      ok: true,
      student: { account: 'bia', label: 'Bia', quotaGb: 20, state: 'free' },
    });
    expect(await ask(message('lab-student-quota', { account: 'ana', quotaGb: 40 }))).toMatchObject({
      ok: true,
      student: { account: 'ana', quotaGb: 40 },
    });
    expect(await ask(message('lab-student-delete', { account: 'ana' }))).toMatchObject({
      ok: true,
      account: 'ana',
    });
    expect(service.studentDelete).toHaveBeenCalledWith('ana', expect.anything());
  });

  it('shows the service refusals as they are', async () => {
    const service = fakeService({
      studentCreate: vi.fn(async () => ({
        ok: false,
        error: 'full',
        message: 'Este PC já tem 100 alunos',
      })),
      studentDelete: vi.fn(async () => ({
        ok: false,
        error: 'busy',
        message: 'Esse aluno está com o PC reservado; encerre a reserva antes',
        account: 'ana',
      })),
      studentSetQuota: vi.fn(async () => ({
        ok: false,
        error: 'not-found',
        message: 'Aluno não encontrado',
      })),
    });
    const { ask } = setup({ service });
    expect(await ask(message('lab-student-add', { label: 'Bia', quotaGb: 20 }))).toMatchObject({
      ok: false,
      error: 'full',
    });
    const busy = await ask(message('lab-student-delete', { account: 'ana' }));
    expect(busy).toMatchObject({ ok: false, error: 'busy' });
    expect(busy).not.toHaveProperty('busyWith');
    expect(await ask(message('lab-student-quota', { account: 'zed', quotaGb: 20 }))).toMatchObject({
      ok: false,
      error: 'not-found',
    });
  });
});

describe('lab host (GOALS 18): reservation, hand-over pieces and the password', () => {
  it('returns the credentials of a reservation, and only there', async () => {
    const { ask, service } = setup();
    const response = await ask(
      message('lab-reserve', { account: 'ana', startWithinMs: 1_800_000, sessionMs: 3_600_000 }),
    );
    expect(response).toMatchObject({
      ok: true,
      request: 'lab-reserve',
      reservationId: 'abcd1234abcd1234',
      account: 'ana',
      userName: 'LABPC\\ana',
      password: PASSWORD,
      startBy: 1000,
      endsAt: 9000,
    });
    expect(service.reserve).toHaveBeenCalledWith(
      { account: 'ana', startWithinMs: 1_800_000, sessionMs: 3_600_000 },
      expect.anything(),
    );
  });

  it('never repeats the password in lab-status, lab-students, any other answer or any log line', async () => {
    const { ask, logs, service } = setup();
    const others = [];
    const reserve = await ask(
      message('lab-reserve', { account: 'ana', startWithinMs: 1_800_000, sessionMs: 3_600_000 }),
    );
    expect(JSON.stringify(reserve)).toContain(PASSWORD);

    // O serviço, por engano, devolve a senha também no status: nada disso passa.
    const withLeak = await service.status();
    service.status.mockResolvedValue({
      ...withLeak,
      password: PASSWORD,
      reservation: { ...RESERVATION, password: PASSWORD },
      students: withLeak.students.map((student) => ({ ...student, password: PASSWORD })),
    });
    others.push(await ask(message('lab-status')));
    others.push(await ask(message('lab-students')));
    others.push(
      await ask(message('lab-extend', { reservationId: 'abcd1234abcd1234', addMs: 600_000 })),
    );
    others.push(
      await ask(message('lab-end', { reservationId: 'abcd1234abcd1234', reason: 'manager-ended' })),
    );
    others.push(await ask(message('lab-folder', { account: 'ana' })));
    for (const answer of others) expect(serializeResponse(answer)).not.toContain(PASSWORD);

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(PASSWORD);
  });

  it('reports busy together with who has the PC and until when', async () => {
    const service = fakeService({
      reserve: vi.fn(async () => ({
        ok: false,
        error: 'busy',
        message: 'O PC já está reservado',
        account: 'ana',
        label: 'Ana Souza',
        state: 'in-use',
        endsAt: 9000,
      })),
    });
    const { ask } = setup({ service });
    const response = await ask(
      message('lab-reserve', { account: 'joao', startWithinMs: 1_800_000, sessionMs: 3_600_000 }),
    );
    expect(response).toMatchObject({
      ok: false,
      error: 'busy',
      busyWith: { account: 'ana', label: 'Ana Souza', state: 'in-use', endsAt: 9000 },
    });
  });

  it('does not invent a reservation from a malformed service answer', async () => {
    const service = fakeService({
      reserve: vi.fn(async () => ({ ok: true, reservationId: 'abcd1234abcd1234', account: 'ana' })),
    });
    const { ask, logs } = setup({ service });
    const response = await ask(
      message('lab-reserve', { account: 'ana', startWithinMs: 1_800_000, sessionMs: 3_600_000 }),
    );
    expect(response).toMatchObject({ ok: false, error: 'internal' });
    expect(logs.some((line) => line.includes('forma esperada'))).toBe(true);
  });

  it('extends and ends a reservation, and reports a logoff that failed', async () => {
    const service = fakeService();
    const { ask } = setup({ service });
    expect(
      await ask(message('lab-extend', { reservationId: 'abcd1234abcd1234', addMs: 600_000 })),
    ).toMatchObject({ ok: true, reservationId: 'abcd1234abcd1234', endsAt: 12000 });
    expect(
      await ask(
        message('lab-end', { reservationId: 'abcd1234abcd1234', reason: 'manager-handover' }),
      ),
    ).toMatchObject({ ok: true, ended: true, reason: 'manager-handover' });
    expect(service.end).toHaveBeenCalledWith(
      { reservationId: 'abcd1234abcd1234', reason: 'manager-handover' },
      expect.anything(),
    );

    service.end.mockResolvedValue({
      ok: false,
      error: 'logoff-failed',
      message: 'Não consegui encerrar a sessão do aluno',
      account: 'ana',
    });
    expect(
      await ask(
        message('lab-end', { reservationId: 'abcd1234abcd1234', reason: 'manager-handover' }),
      ),
    ).toMatchObject({ ok: false, error: 'logoff-failed' });
  });

  it('turns an unknown service error into internal and a dead pipe into service-down', async () => {
    const service = fakeService();
    const { ask } = setup({ service });
    service.end.mockResolvedValue({ ok: false, error: 'weird-code', message: 'C:\\secret\\x' });
    const weird = await ask(
      message('lab-end', { reservationId: 'abcd1234abcd1234', reason: 'manager-ended' }),
    );
    expect(weird).toMatchObject({ ok: false, error: 'internal' });
    expect(JSON.stringify(weird)).not.toContain('secret');
    for (const code of ['service-down', 'unreachable', 'timeout']) {
      service.end.mockResolvedValue({ ok: false, error: code });
      expect(
        await ask(
          message('lab-end', { reservationId: 'abcd1234abcd1234', reason: 'manager-ended' }),
        ),
      ).toMatchObject({ ok: false, error: 'service-down' });
    }
  });
});

describe('lab host (GOALS 18): the read-only folder', () => {
  it('opens the student profile as a read-only file session, without any dialog', async () => {
    const { ask, service } = setup();
    const response = await ask(message('lab-folder', { account: 'ana' }));
    expect(response).toMatchObject({
      ok: true,
      request: 'lab-folder',
      account: 'ana',
      label: 'Ana Souza',
    });
    expect(response[FILE_SESSION]).toEqual({ root: 'C:\\Users\\ana', readOnly: true });
    expect(service.ensureFolderAccess).toHaveBeenCalledWith('ana', expect.anything());
    // O marcador da sessão não vai para a rede.
    expect(serializeResponse(response)).not.toMatch(/readOnly|C:\\\\Users/);
  });

  it.each([
    'C:\\Windows\\System32',
    'C:\\Users',
    'C:\\Users\\Public',
    'C:\\Users\\ana\\..\\..\\Windows',
    'C:\\Users\\ana\\Documents',
    '\\\\server\\share\\ana',
    '',
  ])('refuses a folder the service reports as %j', async (path) => {
    const service = fakeService({
      ensureFolderAccess: vi.fn(async () => ({ ok: true, account: 'ana', path })),
    });
    const { ask } = setup({ service });
    const response = await ask(message('lab-folder', { account: 'ana' }));
    expect(response).toMatchObject({ ok: false, error: 'internal' });
    expect(response[FILE_SESSION]).toBeUndefined();
  });

  it('passes on a student that does not exist', async () => {
    const service = fakeService({
      ensureFolderAccess: vi.fn(async () => ({
        ok: false,
        error: 'not-found',
        message: 'Aluno não encontrado',
      })),
    });
    const { ask } = setup({ service });
    expect(await ask(message('lab-folder', { account: 'zed' }))).toMatchObject({
      ok: false,
      error: 'not-found',
    });
  });
});
