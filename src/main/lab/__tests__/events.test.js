import { describe, expect, it } from 'vitest';
import {
  CSV_COLUMNS,
  END_REASONS,
  EVENT_TYPES,
  buildCsv,
  classifyEvent,
  csvCell,
  formatLocal,
  formatUtc,
  fromJournalEntry,
  groupReservations,
  normalizeIp,
  normalizeLegacy,
  validateEvent,
} from '../events.js';

const AT = Date.parse('2026-10-01T17:30:00Z');
const base = (extra = {}) => ({
  v: 2,
  hostId: 'host-b',
  hostName: 'PC-LAB-01',
  seq: 5,
  at: AT,
  type: 'reservation-start',
  ...extra,
});

describe('event schema v2 (G19-I1)', () => {
  it('lists the documented types and end reasons', () => {
    expect(EVENT_TYPES).toEqual([
      'student-added',
      'student-deleted',
      'quota-changed',
      'reservation-start',
      'reservation-end',
      'session-logon',
      'session-logoff',
      'manager-enrolled',
      'manager-removed',
      'host-lost',
      'host-back',
    ]);
    expect(END_REASONS).toEqual([
      'student-left',
      'manager-ended',
      'manager-handover',
      'deadline',
      'unused-expired',
      'service-restart',
    ]);
  });

  it('accepts a complete event and keeps only the known fields', () => {
    const result = validateEvent(
      base({
        type: 'session-logon',
        student: { label: '  Ana\u0007 Souza ', account: 'anasouza', password: 'x' },
        reservationId: 'abcd1234abcd1234',
        sourceIp: '100.64.0.9',
        detail: 'logon',
        password: 'S3cret',
        extra: { deep: true },
      }),
    );
    expect(result).toEqual({
      ok: true,
      event: {
        v: 2,
        hostId: 'host-b',
        hostName: 'PC-LAB-01',
        seq: 5,
        at: AT,
        type: 'session-logon',
        student: { label: 'Ana  Souza', account: 'anasouza' },
        reservationId: 'abcd1234abcd1234',
        sourceIp: '100.64.0.9',
        detail: 'logon',
      },
    });
  });

  it('accepts an IPv6 source address and a reservation-end with its reason', () => {
    expect(validateEvent(base({ type: 'session-logon', sourceIp: 'fd7a:115c::1' })).ok).toBe(true);
    for (const reason of END_REASONS) {
      expect(validateEvent(base({ type: 'reservation-end', endReason: reason })).ok).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['an array', [base()]],
    ['a string', 'x'],
    ['the wrong version', base({ v: 3 })],
    ['no version (that is a GOALS 4 event)', { ...base(), v: undefined }],
    ['no host id', base({ hostId: '' })],
    ['a host id over 64', base({ hostId: 'x'.repeat(65) })],
    ['a numeric host id', base({ hostId: 5 })],
    ['an unknown type', base({ type: 'teleport' })],
    ['host-lost from the network', base({ type: 'host-lost' })],
    ['host-back from the network', base({ type: 'host-back' })],
    ['seq 0', base({ seq: 0 })],
    ['a negative seq', base({ seq: -1 })],
    ['a fractional seq', base({ seq: 1.5 })],
    ['a string seq', base({ seq: '5' })],
    ['a huge seq', base({ seq: 2 ** 60 })],
    ['a time in 1970', base({ at: 1000 })],
    ['a time in the far future', base({ at: Date.UTC(2200, 0, 1) })],
    ['a string time', base({ at: '2026-10-01' })],
    ['a student that is not an object', base({ student: 'ana' })],
    ['a student account with a path', base({ student: { label: 'x', account: '..\\x' } })],
    ['a bad reservation id', base({ reservationId: '../x' })],
    ['a source that is not an IP', base({ sourceIp: 'evil.example.com' })],
    ['an out-of-range IPv4', base({ sourceIp: '999.1.1.1' })],
    ['an end reason on another event', base({ type: 'session-logon', endReason: 'deadline' })],
    ['an unknown end reason', base({ type: 'reservation-end', endReason: 'whim' })],
    ['a detail that is not text', base({ detail: { x: 1 } })],
  ])('rejects %s', (_name, input) => {
    expect(validateEvent(input).ok).toBe(false);
  });

  it('lets the manager create host-lost and host-back with seq 0, and nothing else', () => {
    expect(validateEvent(base({ type: 'host-lost', seq: 0 }), { local: true }).ok).toBe(true);
    expect(validateEvent(base({ type: 'host-back', seq: 0 }), { local: true }).ok).toBe(true);
    expect(validateEvent(base({ type: 'reservation-start', seq: 0 }), { local: true }).ok).toBe(
      false,
    );
  });

  it('truncates a long detail instead of storing it whole', () => {
    const { event } = validateEvent(base({ detail: 'x'.repeat(5000) }));
    expect([...event.detail]).toHaveLength(200);
  });

  it('never throws, whatever it is given', () => {
    for (const input of [
      undefined,
      0,
      NaN,
      () => {},
      Symbol('x'),
      { v: 2 },
      { v: 2, student: null },
    ]) {
      expect(() => validateEvent(input)).not.toThrow();
    }
  });
});

describe('GOALS 4 events are still accepted', () => {
  it('classifies the shapes', () => {
    expect(classifyEvent({ identity: 'a@b', machineName: 'PC' })).toBe('legacy');
    expect(classifyEvent(base())).toBe('v2');
    expect(classifyEvent({ v: 1 })).toBeNull();
    expect(classifyEvent(null)).toBeNull();
    expect(classifyEvent('x')).toBeNull();
  });

  it('cleans a legacy event and refuses one without who and where', () => {
    expect(
      normalizeLegacy({
        identity: 'aluno@escola.com',
        machineName: 'PC-A',
        startedAt: AT,
        endedAt: AT + 60000,
        durationMs: 60000,
        filesTransferred: 3,
        extra: 'x',
      }),
    ).toEqual({
      identity: 'aluno@escola.com',
      machineName: 'PC-A',
      startedAt: AT,
      endedAt: AT + 60000,
      durationMs: 60000,
      filesTransferred: 3,
    });
    expect(normalizeLegacy({ identity: 'a@b' })).toBeNull();
    expect(normalizeLegacy({ machineName: 'PC' })).toBeNull();
    expect(normalizeLegacy([])).toBeNull();
    expect(
      normalizeLegacy({ identity: 'a', machineName: 'b', durationMs: -5, filesTransferred: 'x' }),
    ).toMatchObject({ durationMs: 0, filesTransferred: 0, startedAt: 0 });
  });
});

describe('from the service journal to a v2 event', () => {
  const host = { hostId: 'host-b', hostName: 'PC-LAB-01' };

  it('maps a journal line and adds the PC', () => {
    expect(
      fromJournalEntry(
        {
          seq: 7,
          at: AT,
          type: 'reservation-end',
          account: 'ana',
          label: 'Ana',
          reservationId: 'abcd1234abcd1234',
          endReason: 'deadline',
        },
        host,
      ),
    ).toEqual({
      v: 2,
      hostId: 'host-b',
      hostName: 'PC-LAB-01',
      seq: 7,
      at: AT,
      type: 'reservation-end',
      student: { label: 'Ana', account: 'ana' },
      reservationId: 'abcd1234abcd1234',
      endReason: 'deadline',
    });
  });

  it('has no student for an event without an account, and drops an invalid line', () => {
    expect(
      fromJournalEntry(
        { seq: 1, at: AT, type: 'manager-enrolled', detail: 'prof@escola.com' },
        host,
      ),
    ).not.toHaveProperty('student');
    expect(fromJournalEntry({ seq: 0, at: AT, type: 'student-added' }, host)).toBeNull();
    expect(fromJournalEntry({ seq: 1, at: AT, type: 'host-lost' }, host)).toBeNull();
    expect(fromJournalEntry(null, host)).toBeNull();
    expect(
      fromJournalEntry(
        { seq: 1, at: AT, type: 'student-added', label: null, account: 'ana' },
        host,
      ),
    ).toMatchObject({
      student: { label: '', account: 'ana' },
    });
  });
});

describe('addresses', () => {
  it('drops the IPv4-mapped prefix', () => {
    expect(normalizeIp('::ffff:100.64.0.9')).toBe('100.64.0.9');
    expect(normalizeIp('100.64.0.9')).toBe('100.64.0.9');
    expect(normalizeIp(undefined)).toBe('');
  });
});

describe('grouping by reservation', () => {
  const ev = (seq, type, minutes, extra = {}) =>
    base({
      seq,
      type,
      at: AT + minutes * 60000,
      reservationId: 'resv0001resv0001',
      student: { label: 'Ana', account: 'ana' },
      ...extra,
    });

  it('summarises a reservation: student, start, end, duration, reason and every sign-in with its address', () => {
    const groups = groupReservations([
      ev(1, 'reservation-start', 0),
      ev(2, 'session-logon', 4, { sourceIp: '100.64.0.9', detail: 'logon' }),
      ev(3, 'session-logoff', 30, { sourceIp: '100.64.0.9', detail: 'disconnect' }),
      ev(4, 'session-logon', 35, { sourceIp: '192.168.1.50', detail: 'reconnect' }),
      ev(5, 'reservation-end', 64, { endReason: 'deadline' }),
      base({ seq: 6, type: 'student-added' }),
    ]);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group).toMatchObject({
      reservationId: 'resv0001resv0001',
      hostName: 'PC-LAB-01',
      student: { label: 'Ana', account: 'ana' },
      startedAt: AT,
      endedAt: AT + 64 * 60000,
      endReason: 'deadline',
      firstLogonAt: AT + 4 * 60000,
      durationMs: 60 * 60000,
    });
    expect(group.signIns.map((s) => [s.kind, s.detail, s.sourceIp])).toEqual([
      ['logon', 'logon', '100.64.0.9'],
      ['logoff', 'disconnect', '100.64.0.9'],
      ['logon', 'reconnect', '192.168.1.50'],
    ]);
    expect(group.events).toHaveLength(5);
  });

  it('measures an unused reservation from its start and orders the newest first', () => {
    const groups = groupReservations([
      ev(1, 'reservation-start', 0),
      ev(2, 'reservation-end', 30, { endReason: 'unused-expired' }),
      ev(3, 'reservation-start', 100, { reservationId: 'resv0002resv0002' }),
    ]);
    expect(groups.map((g) => g.reservationId)).toEqual(['resv0002resv0002', 'resv0001resv0001']);
    expect(groups[1]).toMatchObject({
      durationMs: 30 * 60000,
      endReason: 'unused-expired',
      signIns: [],
    });
    expect(groups[0]).toMatchObject({ endedAt: 0, durationMs: 0 });
  });

  it('keeps the same reservation id on two PCs apart, and ignores events without a reservation', () => {
    const groups = groupReservations([
      ev(1, 'reservation-start', 0),
      ev(1, 'reservation-start', 0, { hostId: 'host-c' }),
      base({ type: 'quota-changed' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groupReservations(null)).toEqual([]);
  });
});

describe('CSV export (G19-I6)', () => {
  const TZ = 'America/Sao_Paulo';

  it('starts with the BOM, uses ; and CRLF, and has the header', () => {
    const csv = buildCsv([], { timeZone: TZ });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toBe(`\uFEFF${CSV_COLUMNS.join(';')}\r\n`);
    expect(CSV_COLUMNS).toContain('Data e hora (local)');
    expect(CSV_COLUMNS).toContain('Data e hora (UTC)');
  });

  it('writes local and UTC times, the Portuguese labels and keeps the accents', () => {
    const csv = buildCsv(
      [
        base({
          type: 'reservation-end',
          endReason: 'manager-handover',
          student: { label: 'João Antônio', account: 'joaoantonio' },
          reservationId: 'abcd1234abcd1234',
          hostName: 'PC do Laboratório',
        }),
      ],
      { timeZone: TZ, receivedAt: () => AT + 5000 },
    );
    const [, row] = csv.split('\r\n');
    expect(row.split(';')).toEqual([
      '01/10/2026 14:30:00',
      '2026-10-01T17:30:00Z',
      'PC do Laboratório',
      'João Antônio',
      'joaoantonio',
      'Reserva encerrada',
      'reservation-end',
      'Troca de aluno',
      '',
      'abcd1234abcd1234',
      '',
      '5',
      '01/10/2026 14:30:05',
    ]);
  });

  it('quotes names that contain ; or quotes or line breaks', () => {
    expect(csvCell('Ana; Souza')).toBe('"Ana; Souza"');
    expect(csvCell('Ana "Nana" Souza')).toBe('"Ana ""Nana"" Souza"');
    expect(csvCell('linha1\nlinha2')).toBe('"linha1\nlinha2"');
    expect(csvCell('simples')).toBe('simples');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
    const csv = buildCsv([base({ student: { label: 'Ana; "A"', account: 'ana' } })], {
      timeZone: TZ,
    });
    expect(csv).toContain('"Ana; ""A"""');
    // Cada linha de dados continua com o mesmo número de colunas.
    const rows = csv.trim().split('\r\n');
    expect(rows).toHaveLength(2);
  });

  it('does not let a spreadsheet run a name that looks like a formula', () => {
    for (const text of ['=HYPERLINK("http://x")', '+1', '-1+1', '@SUM(A1)']) {
      expect(csvCell(text).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('leaves the sequence blank for events the manager created', () => {
    const csv = buildCsv([base({ type: 'host-lost', seq: 0, hostName: 'PC-B' })], { timeZone: TZ });
    const cells = csv.split('\r\n')[1].split(';');
    expect(cells[5]).toBe('PC sem resposta');
    expect(cells[11]).toBe('');
  });

  it('formats times in a given zone and in UTC', () => {
    expect(formatLocal(AT, 'UTC')).toBe('01/10/2026 17:30:00');
    expect(formatLocal(AT, TZ)).toBe('01/10/2026 14:30:00');
    expect(formatLocal(0, TZ)).toBe('');
    expect(formatUtc(AT)).toBe('2026-10-01T17:30:00Z');
    expect(formatUtc(NaN)).toBe('');
  });
});
