import { describe, expect, it } from 'vitest';
import {
  FILE_SESSION,
  IMPLEMENTED_TYPES,
  REQUEST_FIELDS,
  buildError,
  buildSuccess,
  busyPayload,
  credentialsPayload,
  extendPayload,
  parseResponse,
  serializeResponse,
  studentPayload,
  studentsPayload,
} from '../protocol.js';

// As respostas de aluno, reserva e pasta (GOALS 18): listas de permitidos, porque o
// gerente lê a resposta de um PC que não é de confiança e o PC monta a sua a partir do
// que o serviço devolve.

describe('which messages this build answers', () => {
  it('answers every GOALS 18 message and, since GOALS 19, lab-events', () => {
    for (const type of [
      'lab-students',
      'lab-student-add',
      'lab-student-quota',
      'lab-student-delete',
      'lab-reserve',
      'lab-extend',
      'lab-end',
      'lab-folder',
    ]) {
      expect(IMPLEMENTED_TYPES.has(type)).toBe(true);
      expect(Object.hasOwn(REQUEST_FIELDS, type)).toBe(true);
    }
    expect(IMPLEMENTED_TYPES.has('lab-events')).toBe(true);
  });
});

describe('studentPayload / studentsPayload', () => {
  it('keeps the known fields, turns used bytes into GB, and drops everything else', () => {
    expect(
      studentPayload({
        account: 'ana',
        label: '  Ana\u0007Souza ',
        quotaGb: 25,
        state: 'in-use',
        lastSessionEnd: 123,
        usedBytes: 1.5 * 1024 ** 3,
        password: 'S3cret',
        sid: 'S-1-5-21-1',
      }),
    ).toEqual({
      account: 'ana',
      label: 'Ana Souza',
      quotaGb: 25,
      state: 'in-use',
      lastSessionEnd: 123,
      usedGb: 1.5,
    });
  });

  it('survives garbage without throwing', () => {
    for (const bad of [null, undefined, 5, 'x', [], { account: 5, quotaGb: 'a', state: 'weird' }]) {
      const student = studentPayload(bad);
      expect(student.account).toBe('');
      expect(student.state).toBe('free');
      expect(student.quotaGb).toBe(0);
    }
  });

  it('lists students with the reservation, the quota state and the capacity box', () => {
    const payload = studentsPayload({
      quota: 'enforce',
      students: [
        { account: 'ana', label: 'Ana', quotaGb: 25, usedBytes: 0 },
        { account: '../x', label: 'Sem conta' },
        { account: 'joao', label: 'João', quotaGb: 40, state: 'reserved' },
      ],
      reservation: {
        id: 'abcd1234abcd1234',
        account: 'joao',
        label: 'João',
        state: 'reserved',
        startBy: 10,
        endsAt: 20,
      },
      capacity: {
        totalGb: 250,
        freeGb: 120.04,
        reserveGb: 50,
        quotaGb: 25,
        recommended: 2,
        assignedGb: 65,
        usedByStudentsGb: 3.3,
        status: 'tight',
        extra: 'x',
      },
    });
    expect(payload.students.map((s) => s.account)).toEqual(['ana', 'joao']);
    expect(payload.reservation).toMatchObject({ id: 'abcd1234abcd1234', account: 'joao' });
    expect(payload.capacity).toEqual({
      totalGb: 250,
      freeGb: 120,
      reserveGb: 50,
      quotaGb: 25,
      recommended: 2,
      assignedGb: 65,
      usedByStudentsGb: 3.3,
      status: 'tight',
    });
    expect(payload.quota).toBe('enforce');
  });

  it('omits a capacity box without a disk, ignores a malformed reservation, caps the list', () => {
    expect(studentsPayload({ capacity: { totalGb: 'x' }, reservation: { id: '??' } })).toEqual({
      students: [],
      quota: 'unknown',
    });
    const many = Array.from({ length: 150 }, (_, i) => ({ account: `a${i}`, label: 'x' }));
    expect(studentsPayload({ students: many }).students).toHaveLength(100);
    expect(studentsPayload(null).students).toEqual([]);
  });
});

describe('credentialsPayload', () => {
  const good = {
    reservationId: 'abcd1234abcd1234',
    account: 'ana',
    userName: 'LABPC\\ana',
    password: 'Qm7rXk2PzV9tHw4B',
    startBy: 1000,
    endsAt: 9000,
    extra: 'x',
  };

  it('keeps only the credentials', () => {
    expect(credentialsPayload(good)).toEqual({
      reservationId: 'abcd1234abcd1234',
      account: 'ana',
      userName: 'LABPC\\ana',
      password: 'Qm7rXk2PzV9tHw4B',
      startBy: 1000,
      endsAt: 9000,
    });
  });

  it.each([
    ['no password', { password: undefined }],
    ['a short password', { password: 'abc' }],
    ['a password with a space', { password: 'abcd efgh ijkl mnop' }],
    ['a password with a line break', { password: 'abcdefgh\nijklmnop' }],
    ['no user name', { userName: '' }],
    ['a bad account', { account: '../x' }],
    ['a bad reservation id', { reservationId: 'x' }],
  ])('is not credentials with %s', (_name, change) => {
    expect(credentialsPayload({ ...good, ...change })).toBeNull();
  });

  it('is not credentials for a non-object', () => {
    expect(credentialsPayload(null)).toBeNull();
    expect(credentialsPayload('Qm7rXk2PzV9tHw4B')).toBeNull();
  });
});

describe('extendPayload / busyPayload', () => {
  it('reads an extension and refuses one without a valid id', () => {
    expect(extendPayload({ reservationId: 'abcd1234abcd1234', endsAt: 5, x: 1 })).toEqual({
      reservationId: 'abcd1234abcd1234',
      endsAt: 5,
    });
    expect(extendPayload({ reservationId: 'x', endsAt: 5 })).toBeNull();
    expect(extendPayload(null)).toBeNull();
  });

  it('says who has the PC, clean', () => {
    expect(
      busyPayload({ account: 'ana', label: 'Ana\u0000', state: 'in-use', endsAt: 9, secret: 'x' }),
    ).toEqual({ account: 'ana', label: 'Ana', state: 'in-use', endsAt: 9 });
    expect(busyPayload(undefined)).toEqual({
      account: '',
      label: '',
      state: 'reserved',
      endsAt: 0,
    });
  });
});

describe('errors that carry details', () => {
  it('attaches busyWith only for a busy answer that has it', () => {
    const busy = buildError('lab-reserve', 'busy', 'O PC já está reservado', {
      busyWith: { account: 'ana', label: 'Ana', state: 'in-use', endsAt: 9, password: 'x' },
    });
    expect(busy.busyWith).toEqual({ account: 'ana', label: 'Ana', state: 'in-use', endsAt: 9 });
    expect(JSON.stringify(busy)).not.toContain('password');
    expect(buildError('lab-reserve', 'busy', 'x')).not.toHaveProperty('busyWith');
  });

  it('round-trips the new error codes through the wire', () => {
    for (const code of ['not-found', 'full', 'logoff-failed', 'service-down']) {
      const wire = serializeResponse(buildError('lab-end', code, 'm'));
      expect(parseResponse(wire).response.error).toBe(code);
    }
  });

  it('keeps the file-session marker off the wire', () => {
    const response = buildSuccess('lab-folder', { account: 'ana' });
    response[FILE_SESSION] = { root: 'C:\\Users\\ana', readOnly: true };
    const wire = serializeResponse(response);
    expect(wire).not.toContain('Users');
    expect(JSON.parse(wire)).toMatchObject({ ok: true, request: 'lab-folder', account: 'ana' });
  });
});
