import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  LAB_PROTOCOL,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  REQUEST_FIELDS,
  buildError,
  buildRequest,
  buildSuccess,
  parseRequest,
  parseResponse,
  serializeResponse,
  statusPayload,
} from '../protocol.js';

const MIN = 60 * 1000;
const base = (type, fields = {}) => ({
  type,
  labProtocol: LAB_PROTOCOL,
  ...fields,
});

const VALID = [
  base('lab-enroll'),
  base('lab-status'),
  base('lab-students'),
  base('lab-student-add', { label: 'Ana Souza', quotaGb: 25 }),
  base('lab-student-quota', { account: 'ana', quotaGb: 40 }),
  base('lab-student-delete', { account: 'ana' }),
  base('lab-reserve', {
    account: 'ana',
    startWithinMs: 30 * MIN,
    sessionMs: 60 * MIN,
  }),
  base('lab-extend', { reservationId: 'a1b2c3d4-e5f6', addMs: 15 * MIN }),
  base('lab-end', {
    reservationId: 'a1b2c3d4-e5f6',
    reason: 'manager-handover',
  }),
  base('lab-folder', { account: 'ana' }),
  base('lab-events', { sinceSeq: 0, limit: 500 }),
];

describe('parseRequest', () => {
  it.each(VALID.map((request) => [request.type, request]))('accepts a valid %s', (_, request) => {
    expect(parseRequest(JSON.stringify(request))).toEqual({
      ok: true,
      request,
    });
    expect(parseRequest(request)).toEqual({ ok: true, request });
    expect(parseRequest(Buffer.from(JSON.stringify(request)))).toEqual({
      ok: true,
      request,
    });
  });

  it('covers every message type in the spec table', () => {
    expect(new Set(VALID.map((request) => request.type))).toEqual(
      new Set(Object.keys(REQUEST_FIELDS)),
    );
  });

  it('keeps only the fields of the type and ignores the rest', () => {
    const parsed = parseRequest(
      base('lab-status', { password: 'x', extra: { a: 1 }, fromName: 'Eve' }),
    );
    expect(parsed).toEqual({ ok: true, request: base('lab-status') });
  });

  it('trims text fields', () => {
    const parsed = parseRequest(base('lab-student-add', { label: '  Ana  ', quotaGb: 1 }));
    expect(parsed.request.label).toBe('Ana');
  });

  it('rejects a request over 4 KiB without parsing it', () => {
    const big = JSON.stringify(base('lab-status', { pad: 'x'.repeat(MAX_REQUEST_BYTES) }));
    expect(parseRequest(big)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    const atLimit = JSON.stringify(base('lab-status', { pad: '' }));
    expect(Buffer.byteLength(atLimit)).toBeLessThan(MAX_REQUEST_BYTES);
    expect(parseRequest(atLimit).ok).toBe(true);
  });

  it('counts bytes, not characters, for the size limit', () => {
    const wide = JSON.stringify(base('lab-status', { pad: 'é'.repeat(MAX_REQUEST_BYTES / 2) }));
    expect(wide.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(parseRequest(wide)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['empty string', ''],
    ['null', 'null'],
    ['an array', '[1,2]'],
    ['a number', '5'],
    ['an unrelated message type', JSON.stringify({ type: 'connect-request', labProtocol: 1 })],
    ['no type', JSON.stringify({ labProtocol: 1 })],
    ['a non-string type', JSON.stringify({ type: 7, labProtocol: 1 })],
    ['no labProtocol', JSON.stringify({ type: 'lab-status' })],
    ['a string labProtocol', JSON.stringify({ type: 'lab-status', labProtocol: '1' })],
    ['labProtocol 0', JSON.stringify({ type: 'lab-status', labProtocol: 0 })],
    ['a fractional labProtocol', JSON.stringify({ type: 'lab-status', labProtocol: 1.5 })],
  ])('rejects %s as bad-request', (_, input) => {
    expect(parseRequest(input)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
  });

  it('answers unsupported, with the host version, for an unknown lab type', () => {
    expect(parseRequest(base('lab-teleport'))).toEqual({
      ok: false,
      error: 'unsupported',
      message: expect.any(String),
      labProtocol: LAB_PROTOCOL,
    });
  });

  it('answers unsupported for a newer protocol version', () => {
    expect(parseRequest({ type: 'lab-status', labProtocol: LAB_PROTOCOL + 1 })).toMatchObject({
      ok: false,
      error: 'unsupported',
      labProtocol: LAB_PROTOCOL,
    });
  });

  it.each([
    ['a missing field', base('lab-student-add', { label: 'Ana' })],
    ['a wrong-type text', base('lab-student-add', { label: 5, quotaGb: 25 })],
    ['an empty label', base('lab-student-add', { label: '   ', quotaGb: 25 })],
    ['a 41-character label', base('lab-student-add', { label: 'a'.repeat(41), quotaGb: 25 })],
    ['a control character', base('lab-student-add', { label: 'Ana\nSouza', quotaGb: 25 })],
    ['a NUL character', base('lab-student-add', { label: 'An\u0000a', quotaGb: 25 })],
    ['a zero quota', base('lab-student-add', { label: 'Ana', quotaGb: 0 })],
    ['a 2001 GB quota', base('lab-student-add', { label: 'Ana', quotaGb: 2001 })],
    ['a string quota', base('lab-student-add', { label: 'Ana', quotaGb: '25' })],
    ['a fractional quota', base('lab-student-add', { label: 'Ana', quotaGb: 2.5 })],
    ['an account with a path', base('lab-folder', { account: '..\\admin' })],
    ['an account with uppercase', base('lab-folder', { account: 'Ana' })],
    ['an overlong account', base('lab-folder', { account: 'a'.repeat(21) })],
    [
      'a too-short reservation',
      base('lab-reserve', {
        account: 'ana',
        startWithinMs: MIN,
        sessionMs: MIN,
      }),
    ],
    [
      'a reservation over 12 h',
      base('lab-reserve', {
        account: 'ana',
        startWithinMs: MIN,
        sessionMs: 13 * 60 * MIN,
      }),
    ],
    ['a bad reservation id', base('lab-extend', { reservationId: 'x', addMs: MIN })],
    ['an unknown end reason', base('lab-end', { reservationId: 'a1b2c3d4', reason: 'deadline' })],
    ['a negative sequence', base('lab-events', { sinceSeq: -1, limit: 10 })],
    ['a zero limit', base('lab-events', { sinceSeq: 0, limit: 0 })],
    ['a limit over 500', base('lab-events', { sinceSeq: 0, limit: 501 })],
  ])('rejects %s', (_, request) => {
    expect(parseRequest(request)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
  });

  it('never throws, whatever it is given', () => {
    for (const input of [undefined, null, 0, NaN, {}, [], () => {}, Symbol('x'), 10n]) {
      expect(() => parseRequest(input)).not.toThrow();
      expect(parseRequest(input).ok).toBe(false);
    }
    const cyclic = { type: 'lab-status', labProtocol: 1 };
    cyclic.self = cyclic;
    expect(parseRequest(cyclic).ok).toBe(true);
  });

  it('does not treat inherited keys as message types', () => {
    expect(parseRequest(base('constructor'))).toMatchObject({ ok: false });
    expect(parseRequest(base('lab-toString'))).toMatchObject({
      ok: false,
      error: 'unsupported',
    });
  });
});

describe('buildRequest', () => {
  it('builds the text a host accepts back', () => {
    for (const request of VALID) {
      const { type, labProtocol, ...fields } = request;
      const built = buildRequest(type, fields);
      expect(built.ok).toBe(true);
      expect(parseRequest(built.text)).toEqual({ ok: true, request });
      expect(labProtocol).toBe(LAB_PROTOCOL);
    }
  });

  it('refuses to build what the host would refuse', () => {
    expect(buildRequest('lab-student-add', { label: '', quotaGb: 25 })).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(buildRequest('lab-nope')).toMatchObject({
      ok: false,
      error: 'unsupported',
    });
    expect(buildRequest(null)).toMatchObject({ ok: false });
    expect(buildRequest('lab-status', 'oops')).toMatchObject({ ok: true });
  });
});

describe('responses', () => {
  it('builds success and error envelopes', () => {
    expect(buildSuccess('lab-status', { managed: true })).toEqual({
      type: 'lab-response',
      request: 'lab-status',
      ok: true,
      labProtocol: LAB_PROTOCOL,
      managed: true,
    });
    expect(buildError('lab-status', 'unauthorized', 'Sem acesso')).toEqual({
      type: 'lab-response',
      request: 'lab-status',
      ok: false,
      error: 'unauthorized',
      message: 'Sem acesso',
      labProtocol: LAB_PROTOCOL,
    });
  });

  it('keeps every documented error code and maps anything else to internal', () => {
    expect(ERROR_CODES).toEqual([
      'unauthorized',
      'locked',
      'busy',
      'bad-request',
      'unsupported',
      'internal',
    ]);
    for (const code of ERROR_CODES) expect(buildError('lab-status', code).error).toBe(code);
    expect(buildError('lab-status', 'made-up').error).toBe('internal');
    expect(buildError('lab-status', 'busy')).not.toHaveProperty('message');
  });

  it('replaces a response over 256 KiB with an internal error', () => {
    const huge = buildSuccess('lab-events', {
      events: 'x'.repeat(MAX_RESPONSE_BYTES),
    });
    const body = serializeResponse(huge);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: 'internal',
      request: 'lab-events',
    });
    const fine = serializeResponse(buildSuccess('lab-status'));
    expect(JSON.parse(fine).ok).toBe(true);
  });

  it('serializes a response that cannot be stringified as an internal error', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(JSON.parse(serializeResponse(cyclic))).toMatchObject({
      ok: false,
      error: 'internal',
    });
  });

  it('parses what the host serializes', () => {
    const response = buildSuccess('lab-status', { managed: true });
    expect(parseResponse(serializeResponse(response))).toEqual({
      ok: true,
      response,
    });
    const refused = buildError('lab-status', 'locked');
    expect(parseResponse(serializeResponse(refused))).toMatchObject({
      ok: true,
      response: { ok: false, error: 'locked' },
    });
  });

  it('rejects malformed responses without throwing', () => {
    for (const input of ['', '{', 'null', '[]', JSON.stringify({ type: 'connect-response' })]) {
      expect(parseResponse(input)).toMatchObject({
        ok: false,
        error: 'bad-response',
      });
    }
    expect(parseResponse(JSON.stringify({ type: 'lab-response', ok: 'yes' })).ok).toBe(false);
    expect(parseResponse('x'.repeat(MAX_RESPONSE_BYTES + 1)).ok).toBe(false);
  });

  it('maps an unknown error code from the other side to internal', () => {
    const parsed = parseResponse(
      JSON.stringify({
        type: 'lab-response',
        ok: false,
        error: 'weird',
        labProtocol: 1,
      }),
    );
    expect(parsed.response.error).toBe('internal');
  });
});

describe('statusPayload', () => {
  const full = {
    hostId: 'a1b2c3d4-0000-4000-8000-000000000001',
    hostName: 'PC-LAB-01',
    appVersion: '1.0.8',
    managed: true,
    service: { installed: true, running: true },
    state: 'in-use',
    student: { label: 'Ana', since: 1000, endsAt: 5000 },
    studentCount: 3,
    disk: { totalGb: 250, freeGb: 120.46 },
  };

  it('has exactly the documented shape', () => {
    expect(statusPayload(full)).toEqual({
      ...full,
      disk: { totalGb: 250, freeGb: 120.5 },
    });
    expect(Object.keys(statusPayload(full)).sort()).toEqual(
      [
        'appVersion',
        'disk',
        'hostId',
        'hostName',
        'managed',
        'service',
        'state',
        'student',
        'studentCount',
      ].sort(),
    );
  });

  it('defaults to a free PC with no service', () => {
    expect(statusPayload({ hostId: 'h', hostName: 'n', appVersion: '1' })).toEqual({
      hostId: 'h',
      hostName: 'n',
      appVersion: '1',
      managed: false,
      service: { installed: false, running: false },
      state: 'free',
      studentCount: 0,
    });
    expect(statusPayload()).toMatchObject({ state: 'free', managed: false });
    expect(statusPayload('nonsense')).toMatchObject({ state: 'free' });
  });

  it('lets no password, token or secret through at any depth', () => {
    const dirty = {
      ...full,
      password: 'S3cret!',
      sessionPassword: 'ABCD-EFGH',
      token: 'tok',
      vncPassword: 'vnc',
      service: {
        installed: true,
        running: true,
        password: 'p',
        pipeToken: 't',
      },
      student: {
        label: 'Ana',
        since: 1,
        endsAt: 2,
        password: 'p',
        account: 'ana',
      },
      disk: { totalGb: 10, freeGb: 5, secret: 's' },
    };
    const out = JSON.stringify(statusPayload(dirty));
    for (const leak of ['S3cret!', 'ABCD-EFGH', 'tok', 'vnc', 'pipeToken', '"p"', 'secret']) {
      expect(out).not.toContain(leak);
    }
    expect(out).not.toMatch(/pass|token|secret/i);
  });

  it('drops the student of a free PC and bad disk values', () => {
    expect(statusPayload({ ...full, state: 'free' })).not.toHaveProperty('student');
    expect(statusPayload({ ...full, disk: { totalGb: 'x', freeGb: 5 } })).not.toHaveProperty(
      'disk',
    );
    expect(statusPayload({ ...full, disk: { totalGb: -1, freeGb: 5 } })).not.toHaveProperty('disk');
    expect(statusPayload({ ...full, state: 'weird' }).state).toBe('free');
  });

  it('cleans and bounds the text fields', () => {
    const out = statusPayload({
      ...full,
      hostName: `PC\n${'x'.repeat(300)}`,
      appVersion: 5,
    });
    expect(out.hostName.length).toBeLessThanOrEqual(100);
    expect(out.hostName).not.toContain('\n');
    expect(out.appVersion).toBe('');
  });
});
