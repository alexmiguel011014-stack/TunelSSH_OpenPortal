import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLabHost } from '../host.js';
import { createLabStore } from '../lab-store.js';
import { createEnrollmentDialog, enrollmentDialogOptions } from '../enrollment-dialog.js';
import { LAB_PROTOCOL } from '../protocol.js';
import { FailureLimiter, MAX_FAILURES } from '../../connection/session-password.js';

const PROF = 'prof@escola.com';
const MANAGER_IP = '100.64.0.10';
const STRANGER_IP = '100.64.0.20';
const status = JSON.stringify({
  type: 'lab-status',
  labProtocol: LAB_PROTOCOL,
});
const enrollMsg = JSON.stringify({
  type: 'lab-enroll',
  labProtocol: LAB_PROTOCOL,
});

function setup({ managers = [], identities = {}, ask, statusInput } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  let disk = managers.length ? { lab: { managers } } : {};
  const store = createLabStore({
    read: () => structuredClone(disk),
    write: (next) => {
      disk = structuredClone(next);
    },
    randomUUID: () => 'host-uuid-1',
  });
  const resolveIdentity = vi.fn(async (ip) => identities[ip] ?? 'unknown');
  const askEnrollment = vi.fn(ask ?? (async () => 'accepted'));
  const onEnrolled = vi.fn();
  const host = createLabHost({
    resolveIdentity,
    limiter: new FailureLimiter({ now }),
    store,
    askEnrollment,
    info: { hostName: () => 'PC-LAB-01', appVersion: () => '1.0.8' },
    getStatusInput: statusInput,
    onEnrolled,
    now,
  });
  return {
    host,
    store,
    resolveIdentity,
    askEnrollment,
    onEnrolled,
    clock,
    peek: () => disk,
  };
}

const ask = (host, input, remoteAddress, signal) => host.handle({ input, remoteAddress, signal });

describe('lab host: authorization of lab-status', () => {
  it('serves a manager identified by whois on the real socket address', async () => {
    const { host, resolveIdentity } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
    });
    const response = await ask(host, status, `::ffff:${MANAGER_IP}`);
    expect(resolveIdentity).toHaveBeenCalledWith(MANAGER_IP);
    expect(response).toMatchObject({
      type: 'lab-response',
      request: 'lab-status',
      ok: true,
      labProtocol: LAB_PROTOCOL,
      hostId: 'host-uuid-1',
      hostName: 'PC-LAB-01',
      appVersion: '1.0.8',
      managed: true,
      state: 'free',
      service: { installed: false, running: false },
      studentCount: 0,
    });
  });

  it('refuses a login that is not a manager', async () => {
    const { host } = setup({
      managers: [PROF],
      identities: { [STRANGER_IP]: 'aluno@escola.com' },
    });
    expect(await ask(host, status, STRANGER_IP)).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
  });

  it('refuses an unknown identity, even when the managers list says "unknown"', async () => {
    const { host } = setup({ managers: [PROF] });
    expect(await ask(host, status, STRANGER_IP)).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
  });

  it('ignores a forged fromName/identity inside the message', async () => {
    const { host } = setup({
      managers: [PROF],
      identities: { [STRANGER_IP]: 'aluno@escola.com' },
    });
    const forged = JSON.stringify({
      type: 'lab-status',
      labProtocol: LAB_PROTOCOL,
      fromName: PROF,
      identity: PROF,
      login: PROF,
    });
    expect(await ask(host, forged, STRANGER_IP)).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
  });

  it('answers a PC that was never enrolled with unauthorized, not a status', async () => {
    const { host } = setup({ identities: { [MANAGER_IP]: PROF } });
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
  });

  it('locks an IP after five refusals and stops running whois for it', async () => {
    const { host, resolveIdentity } = setup({
      managers: [PROF],
      identities: { [STRANGER_IP]: 'aluno@escola.com' },
    });
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      expect(await ask(host, status, STRANGER_IP)).toMatchObject({
        error: 'unauthorized',
      });
    }
    expect(await ask(host, status, STRANGER_IP)).toMatchObject({
      error: 'locked',
    });
    const calls = resolveIdentity.mock.calls.length;
    expect(await ask(host, status, STRANGER_IP)).toMatchObject({
      error: 'locked',
    });
    expect(resolveIdentity.mock.calls.length).toBe(calls);
  });

  it('does not lock an IP because of another IP', async () => {
    const { host } = setup({
      managers: [PROF],
      identities: { [STRANGER_IP]: 'aluno@escola.com', [MANAGER_IP]: PROF },
    });
    for (let i = 0; i < MAX_FAILURES; i++) await ask(host, status, STRANGER_IP);
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({ ok: true });
  });

  it('a manager success clears earlier refusals of the same IP', async () => {
    const { host, store } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: 'x@y.com' },
    });
    for (let i = 0; i < MAX_FAILURES - 1; i++) await ask(host, status, MANAGER_IP);
    store.addManager('x@y.com');
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({ ok: true });
    store.removeManager('x@y.com');
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({
      error: 'unauthorized',
    });
  });

  it('caches the identity for 60 s per IP, and a stale one is looked up again', async () => {
    const { host, resolveIdentity, clock } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
    });
    await ask(host, status, MANAGER_IP);
    await ask(host, status, MANAGER_IP);
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    clock.t += 59_000;
    await ask(host, status, MANAGER_IP);
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    clock.t += 2_000;
    await ask(host, status, MANAGER_IP);
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it('remembers "unknown" only briefly, so a Tailscale that just came up is noticed', async () => {
    const { host, resolveIdentity, clock } = setup({ managers: [PROF] });
    await ask(host, status, MANAGER_IP);
    clock.t += 6_000;
    await ask(host, status, MANAGER_IP);
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it('a removed manager is refused on the next request, cache or not', async () => {
    const { host, store } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
    });
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({ ok: true });
    store.removeManager(PROF);
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({
      error: 'unauthorized',
    });
  });

  it('treats a failing whois as unknown', async () => {
    const { host, resolveIdentity } = setup({ managers: [PROF] });
    resolveIdentity.mockRejectedValue(new Error('boom'));
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({
      error: 'unauthorized',
    });
  });
});

describe('lab host: bad input and unsupported messages', () => {
  it('answers bad-request for malformed, oversize or unversioned input', async () => {
    const { host } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
    });
    for (const input of [
      '{nope',
      JSON.stringify({ type: 'lab-status' }),
      JSON.stringify({
        type: 'lab-status',
        labProtocol: 1,
        pad: 'x'.repeat(5000),
      }),
    ]) {
      expect(await ask(host, input, MANAGER_IP)).toMatchObject({
        ok: false,
        error: 'bad-request',
      });
    }
  });

  it('answers unsupported for a newer protocol and an unknown type', async () => {
    const { host } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
    });
    const newer = JSON.stringify({
      type: 'lab-status',
      labProtocol: LAB_PROTOCOL + 1,
    });
    expect(await ask(host, newer, MANAGER_IP)).toMatchObject({
      error: 'unsupported',
      labProtocol: LAB_PROTOCOL,
    });
    const unknown = JSON.stringify({ type: 'lab-teleport', labProtocol: 1 });
    expect(await ask(host, unknown, MANAGER_IP)).toMatchObject({
      error: 'unsupported',
    });
  });

  it('a manager asking for a later-GOALS message gets unsupported, a stranger gets unauthorized', async () => {
    const { host } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF, [STRANGER_IP]: 'aluno@escola.com' },
    });
    const students = JSON.stringify({ type: 'lab-students', labProtocol: 1 });
    expect(await ask(host, students, MANAGER_IP)).toMatchObject({
      error: 'unsupported',
      request: 'lab-students',
    });
    expect(await ask(host, students, STRANGER_IP)).toMatchObject({
      error: 'unauthorized',
    });
  });

  it('never throws, even if the store does', async () => {
    const { host, store } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
    });
    store.getLab = () => {
      throw new Error('disk gone');
    };
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({
      ok: false,
      error: 'internal',
    });
    expect(await ask(host, status, '')).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
  });
});

describe('lab host: status never carries a secret', () => {
  it('drops a password or token even if the lower layer returns one', async () => {
    const { host } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
      statusInput: () => ({
        password: 'S3cret!',
        sessionPassword: 'ABCD-EFGH',
        token: 'tok',
        state: 'in-use',
        student: { label: 'Ana', since: 1, endsAt: 2, password: 'p4ss' },
        service: { installed: true, running: true, pipeSecret: 'x' },
      }),
    });
    const response = await ask(host, status, MANAGER_IP);
    const text = JSON.stringify(response);
    for (const leak of ['S3cret!', 'ABCD-EFGH', 'tok', 'p4ss', 'pipeSecret']) {
      expect(text).not.toContain(leak);
    }
    expect(response).toMatchObject({
      state: 'in-use',
      student: { label: 'Ana' },
    });
  });
});

describe('lab host: enrollment by the owner of the PC', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accept: adds the verified login as manager and answers with the PC identity', async () => {
    const { host, askEnrollment, onEnrolled, peek } = setup({
      identities: { [MANAGER_IP]: PROF },
    });
    const response = await ask(host, enrollMsg, MANAGER_IP);
    expect(response).toMatchObject({
      ok: true,
      request: 'lab-enroll',
      accepted: true,
      hostId: 'host-uuid-1',
      hostName: 'PC-LAB-01',
      appVersion: '1.0.8',
      labProtocol: LAB_PROTOCOL,
    });
    expect(askEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({ login: PROF, remoteAddress: MANAGER_IP }),
    );
    expect(peek().lab.managers).toEqual([PROF]);
    expect(onEnrolled).toHaveBeenCalledWith(PROF);
  });

  it('names the whois login in the dialog, not the self-declared name', async () => {
    const { host, askEnrollment } = setup({
      identities: { [MANAGER_IP]: PROF },
    });
    const forged = JSON.stringify({
      type: 'lab-enroll',
      labProtocol: LAB_PROTOCOL,
      fromName: 'Diretor',
      login: 'diretor@escola.com',
    });
    await ask(host, forged, MANAGER_IP);
    const [{ login }] = askEnrollment.mock.calls[0];
    expect(login).toBe(PROF);
    expect(JSON.stringify(askEnrollment.mock.calls[0])).not.toContain('Diretor');
  });

  it('reject: nothing is enrolled and the answer says so', async () => {
    const { host, peek } = setup({
      identities: { [MANAGER_IP]: PROF },
      ask: async () => 'rejected',
    });
    expect(await ask(host, enrollMsg, MANAGER_IP)).toMatchObject({
      ok: true,
      accepted: false,
      reason: 'rejected',
    });
    expect(peek().lab).toBeUndefined();
  });

  it('five rejections lock the IP, so a spammer cannot flood the owner with dialogs', async () => {
    const { host, askEnrollment } = setup({
      identities: { [MANAGER_IP]: PROF },
      ask: async () => 'rejected',
    });
    for (let i = 0; i < MAX_FAILURES; i++) await ask(host, enrollMsg, MANAGER_IP);
    expect(askEnrollment).toHaveBeenCalledTimes(MAX_FAILURES);
    expect(await ask(host, enrollMsg, MANAGER_IP)).toMatchObject({
      error: 'locked',
    });
    expect(askEnrollment).toHaveBeenCalledTimes(MAX_FAILURES);
  });

  it('timeout: the dialog is aborted after 60 s and nothing is enrolled', async () => {
    let dialogSignal;
    const { host, peek } = setup({
      identities: { [MANAGER_IP]: PROF },
      ask: ({ signal }) => {
        dialogSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('accepted'));
        });
      },
    });
    const pending = ask(host, enrollMsg, MANAGER_IP);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(dialogSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(dialogSignal.aborted).toBe(true);
    // Mesmo que o diálogo responda "aceitar" no limite, o prazo já venceu.
    expect(await pending).toMatchObject({
      ok: true,
      accepted: false,
      reason: 'timeout',
    });
    expect(peek().lab).toBeUndefined();
  });

  it('abandon: if the asker gives up, the dialog closes and there is nothing to answer', async () => {
    let dialogSignal;
    const { host, peek } = setup({
      identities: { [MANAGER_IP]: PROF },
      ask: ({ signal }) => {
        dialogSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve('accepted'));
        });
      },
    });
    const asker = new AbortController();
    const pending = ask(host, enrollMsg, MANAGER_IP, asker.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    asker.abort();
    expect(await pending).toBeNull();
    expect(dialogSignal.aborted).toBe(true);
    expect(peek().lab).toBeUndefined();
  });

  it('an unknown identity is refused without opening a dialog', async () => {
    const { host, askEnrollment } = setup();
    expect(await ask(host, enrollMsg, MANAGER_IP)).toMatchObject({
      ok: false,
      error: 'unauthorized',
    });
    expect(askEnrollment).not.toHaveBeenCalled();
  });

  it('a login that already manages the PC is accepted again without a dialog', async () => {
    const { host, askEnrollment } = setup({
      managers: [PROF],
      identities: { [MANAGER_IP]: PROF },
    });
    expect(await ask(host, enrollMsg, MANAGER_IP)).toMatchObject({
      ok: true,
      accepted: true,
    });
    expect(askEnrollment).not.toHaveBeenCalled();
  });

  it('only one dialog is open at a time; the next asker gets busy, then can try again', async () => {
    let release;
    const { host, askEnrollment } = setup({
      identities: { [MANAGER_IP]: PROF, [STRANGER_IP]: 'outro@escola.com' },
      ask: () => new Promise((resolve) => (release = resolve)),
    });
    const first = ask(host, enrollMsg, MANAGER_IP);
    await vi.advanceTimersByTimeAsync(10);
    expect(await ask(host, enrollMsg, STRANGER_IP)).toMatchObject({
      ok: false,
      error: 'busy',
    });
    expect(askEnrollment).toHaveBeenCalledTimes(1);
    release('rejected');
    await first;
    askEnrollment.mockImplementation(async () => 'accepted');
    expect(await ask(host, enrollMsg, STRANGER_IP)).toMatchObject({
      ok: true,
      accepted: true,
    });
  });

  it('a dialog that throws counts as a rejection', async () => {
    const { host } = setup({
      identities: { [MANAGER_IP]: PROF },
      ask: async () => {
        throw new Error('window closed');
      },
    });
    expect(await ask(host, enrollMsg, MANAGER_IP)).toMatchObject({
      accepted: false,
      reason: 'rejected',
    });
  });

  it('after enrolling, the same IP is served as a manager', async () => {
    const { host } = setup({ identities: { [MANAGER_IP]: PROF } });
    await ask(host, enrollMsg, MANAGER_IP);
    expect(await ask(host, status, MANAGER_IP)).toMatchObject({
      ok: true,
      managed: true,
    });
  });

  it('reports internal when the manager cannot be stored', async () => {
    const { host, store } = setup({ identities: { [MANAGER_IP]: PROF } });
    store.addManager = () => ({ ok: false, error: 'full' });
    expect(await ask(host, enrollMsg, MANAGER_IP)).toMatchObject({
      ok: false,
      error: 'internal',
    });
  });
});

describe('enrollment dialog', () => {
  it('shows the verified login, defaults to Rejeitar and closes with the signal', async () => {
    const options = enrollmentDialogOptions(PROF, 'SIGNAL');
    expect(options.message).toContain(PROF);
    expect(options.buttons).toEqual(['Aceitar', 'Rejeitar']);
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
    expect(options.signal).toBe('SIGNAL');
    expect(options.detail).toContain('Este PC é gerenciado');
  });

  it('answers accepted only for the Aceitar button of a still-open dialog', async () => {
    const release = vi.fn();
    const draw = vi.fn(() => release);
    const controller = new AbortController();
    const dialog = createEnrollmentDialog({
      showDialog: vi.fn().mockResolvedValue({ response: 0 }),
      drawAttention: draw,
    });
    expect(await dialog({ login: PROF, signal: controller.signal })).toBe('accepted');
    expect(draw).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    const rejecting = createEnrollmentDialog({
      showDialog: async () => ({ response: 1 }),
    });
    expect(await rejecting({ login: PROF, signal: controller.signal })).toBe('rejected');

    controller.abort();
    expect(await dialog({ login: PROF, signal: controller.signal })).toBe('rejected');

    const failing = createEnrollmentDialog({
      showDialog: async () => {
        throw new Error('x');
      },
    });
    expect(await failing({ login: PROF, signal: new AbortController().signal })).toBe('rejected');
  });
});
