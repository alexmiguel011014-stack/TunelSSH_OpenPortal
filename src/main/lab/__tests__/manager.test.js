import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLabManager } from '../manager.js';
import { createLabStore } from '../lab-store.js';
import { buildError, buildSuccess, LAB_PROTOCOL } from '../protocol.js';
import { MAX_ROSTER } from '../lab-config.js';

const ok = (response) => ({ ok: true, response });
const down = (error = 'unreachable') => ({ ok: false, error, message: 'x' });

const statusOf = (hostId, extra = {}) =>
  ok(
    buildSuccess('lab-status', {
      hostId,
      hostName: `PC-${hostId}`,
      appVersion: '1.0.8',
      managed: true,
      service: { installed: false, running: false },
      state: 'free',
      studentCount: 0,
      ...extra,
    }),
  );

const enrolled = (hostId = 'host-b', name = 'PC-B') =>
  ok(
    buildSuccess('lab-enroll', {
      accepted: true,
      hostId,
      hostName: name,
      appVersion: '1.0.8',
    }),
  );

function setup({ roster = [], send } = {}) {
  let disk = roster.length ? { lab: { roster } } : {};
  const store = createLabStore({
    read: () => structuredClone(disk),
    write: (next) => {
      disk = structuredClone(next);
    },
  });
  const sendRequest = vi.fn(send ?? (async () => down()));
  const onChange = vi.fn();
  const clock = { t: 5_000 };
  const manager = createLabManager({
    store,
    sendRequest,
    isAllowedHost: (host) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host),
    now: () => clock.t,
    onChange,
  });
  return { manager, store, sendRequest, onChange, clock };
}

const pc = (n) => ({
  hostId: `host-${n}`,
  name: `PC ${n}`,
  host: `100.64.0.${n}`,
  enrolledAt: n,
});

describe('lab manager: enrollment', () => {
  it('adds a PC the owner accepted and starts watching it', async () => {
    const { manager, store, sendRequest, onChange } = setup({
      send: async (host, built) =>
        built.request.type === 'lab-enroll' ? enrolled() : statusOf('host-b'),
    });
    const result = await manager.enroll(' 100.64.0.7 ');
    expect(result).toMatchObject({
      ok: true,
      added: true,
      entry: { hostId: 'host-b', host: '100.64.0.7' },
    });
    expect(store.getLab().roster).toEqual([
      { hostId: 'host-b', name: 'PC-B', host: '100.64.0.7', enrolledAt: 5_000 },
    ]);
    expect(sendRequest.mock.calls[0][0]).toBe('100.64.0.7');
    expect(sendRequest.mock.calls[0][2]).toEqual({ timeoutMs: 70_000 });
    expect(onChange).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(manager.snapshot()[0]).toMatchObject({
        hostId: 'host-b',
        state: 'free',
      }),
    );
  });

  it('refuses an address outside the Tailscale range without contacting anything', async () => {
    const { manager, sendRequest } = setup();
    for (const host of ['', '192.168.1.5', '8.8.8.8', 'pc-b', undefined, 5]) {
      expect(await manager.enroll(host)).toMatchObject({
        ok: false,
        error: 'bad-host',
      });
    }
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('reports the owner rejecting, and nobody answering', async () => {
    const reject = setup({
      send: async () => ok(buildSuccess('lab-enroll', { accepted: false, reason: 'rejected' })),
    });
    expect(await reject.manager.enroll('100.64.0.7')).toMatchObject({
      ok: false,
      error: 'rejected',
    });
    const late = setup({
      send: async () => ok(buildSuccess('lab-enroll', { accepted: false, reason: 'timeout' })),
    });
    expect(await late.manager.enroll('100.64.0.7')).toMatchObject({
      ok: false,
      error: 'timeout',
    });
    expect(reject.store.getLab().roster).toEqual([]);
    expect(late.store.getLab().roster).toEqual([]);
  });

  it.each([
    ['unreachable', down('unreachable')],
    ['timeout', down('timeout')],
    ['bad-response', down('bad-response')],
    ['unauthorized', ok(buildError('lab-enroll', 'unauthorized'))],
    ['locked', ok(buildError('lab-enroll', 'locked'))],
    ['busy', ok(buildError('lab-enroll', 'busy'))],
    ['unsupported', ok(buildError('lab-enroll', 'unsupported'))],
  ])('turns a %s failure into a readable message', async (code, reply) => {
    const { manager, store } = setup({ send: async () => reply });
    const result = await manager.enroll('100.64.0.7');
    expect(result).toMatchObject({ ok: false, error: code });
    expect(result.message.length).toBeGreaterThan(10);
    expect(store.getLab().roster).toEqual([]);
  });

  it('refuses a roster that is full, and a reply without a usable hostId', async () => {
    const roster = Array.from({ length: MAX_ROSTER }, (_, i) => pc(i + 1));
    const full = setup({ roster, send: async () => enrolled('brand-new') });
    expect(await full.manager.enroll('100.64.0.200')).toMatchObject({
      ok: false,
      error: 'full',
    });
    const bad = setup({ send: async () => enrolled('') });
    expect(await bad.manager.enroll('100.64.0.7')).toMatchObject({
      ok: false,
      error: 'invalid',
    });
  });

  it('enrolling a PC already in the list updates it instead of duplicating', async () => {
    const { manager, store } = setup({
      roster: [pc(7)],
      send: async (host, built) =>
        built.request.type === 'lab-enroll' ? enrolled('host-7', 'PC 7 novo') : statusOf('host-7'),
    });
    expect(await manager.enroll('100.64.0.7')).toMatchObject({
      ok: true,
      added: false,
    });
    expect(store.getLab().roster).toHaveLength(1);
  });
});

describe('lab manager: polling', () => {
  it('shows "checking" before the first answer', () => {
    const { manager } = setup({ roster: [pc(1)] });
    expect(manager.snapshot()[0]).toMatchObject({
      hostId: 'host-1',
      state: 'checking',
    });
  });

  it('reads free / reserved / in-use from the PC', async () => {
    const states = {
      'host-1': 'free',
      'host-2': 'reserved',
      'host-3': 'in-use',
    };
    const { manager } = setup({
      roster: [pc(1), pc(2), pc(3)],
      send: async (host) => {
        const hostId = `host-${host.split('.').pop()}`;
        return statusOf(hostId, {
          state: states[hostId],
          ...(states[hostId] === 'free' ? {} : { student: { label: 'Ana', since: 1, endsAt: 2 } }),
          studentCount: 2,
        });
      },
    });
    await manager.pollOnce();
    const byId = Object.fromEntries(manager.snapshot().map((entry) => [entry.hostId, entry]));
    expect(byId['host-1']).toMatchObject({
      state: 'free',
      studentCount: 2,
      appVersion: '1.0.8',
    });
    expect(byId['host-2']).toMatchObject({
      state: 'reserved',
      student: { label: 'Ana' },
    });
    expect(byId['host-3'].state).toBe('in-use');
    expect(byId['host-1'].lastSeenAt).toBe(5_000);
  });

  it('polls with a 3 s timeout and at most 8 PCs at once', async () => {
    const roster = Array.from({ length: 20 }, (_, i) => pc(i + 1));
    let inFlight = 0;
    let peak = 0;
    const { manager, sendRequest } = setup({
      roster,
      send: async (host) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return statusOf(`host-${host.split('.').pop()}`);
      },
    });
    await manager.pollOnce();
    expect(sendRequest).toHaveBeenCalledTimes(20);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
    expect(sendRequest.mock.calls[0][2]).toEqual({ timeoutMs: 3_000 });
  });

  it('keeps the last state after one missed poll and goes offline after two', async () => {
    let up = true;
    const { manager } = setup({
      roster: [pc(1)],
      send: async () => (up ? statusOf('host-1') : down('timeout')),
    });
    await manager.pollOnce();
    up = false;
    await manager.pollOnce();
    expect(manager.snapshot()[0].state).toBe('free');
    await manager.pollOnce();
    expect(manager.snapshot()[0].state).toBe('offline');
    up = true;
    await manager.pollOnce();
    expect(manager.snapshot()[0].state).toBe('free');
  });

  it('a PC that never answers is offline after two polls, others stay unaffected', async () => {
    const { manager } = setup({
      roster: [pc(1), pc(2)],
      send: async (host) => (host.endsWith('.1') ? down() : statusOf('host-2')),
    });
    await manager.pollOnce();
    await manager.pollOnce();
    const states = manager.snapshot().map((entry) => entry.state);
    expect(states).toEqual(['offline', 'free']);
  });

  it('flags another protocol version as incompatible, from the number or from the error', async () => {
    const newer = setup({
      roster: [pc(1)],
      send: async () =>
        ok({
          ...buildSuccess('lab-status', { hostId: 'host-1' }),
          labProtocol: LAB_PROTOCOL + 1,
        }),
    });
    await newer.manager.pollOnce();
    expect(newer.manager.snapshot()[0].state).toBe('incompatible');
    const older = setup({
      roster: [pc(1)],
      send: async () => ok(buildError('lab-status', 'unsupported')),
    });
    await older.manager.pollOnce();
    expect(older.manager.snapshot()[0].state).toBe('incompatible');
  });

  it('flags a PC that no longer recognises this manager as refused', async () => {
    const { manager } = setup({
      roster: [pc(1)],
      send: async () => ok(buildError('lab-status', 'unauthorized')),
    });
    await manager.pollOnce();
    expect(manager.snapshot()[0]).toMatchObject({
      state: 'refused',
      error: 'unauthorized',
    });
  });

  it('does not trust an address that now answers as a different PC', async () => {
    const { manager } = setup({
      roster: [pc(1)],
      send: async () => statusOf('someone-else'),
    });
    await manager.pollOnce();
    expect(manager.snapshot()[0]).toMatchObject({
      state: 'offline',
      error: 'host-mismatch',
    });
  });

  it('never exposes a secret a misbehaving PC adds to its answer', async () => {
    const { manager } = setup({
      roster: [pc(1)],
      send: async () =>
        statusOf('host-1', {
          password: 'S3cret!',
          token: 'tok',
          service: { installed: true, running: true, key: 'k' },
        }),
    });
    await manager.pollOnce();
    const text = JSON.stringify(manager.snapshot());
    expect(text).not.toMatch(/S3cret|tok|"key"/);
  });

  it('removing a PC drops it from the list and from the state', async () => {
    const { manager, store } = setup({
      roster: [pc(1), pc(2)],
      send: async (host) => statusOf(`host-${host.split('.').pop()}`),
    });
    await manager.pollOnce();
    expect(manager.remove('host-1')).toEqual({ ok: true });
    expect(manager.remove('host-1')).toEqual({ ok: false });
    expect(store.getLab().roster.map((entry) => entry.hostId)).toEqual(['host-2']);
    expect(manager.snapshot().map((entry) => entry.hostId)).toEqual(['host-2']);
  });

  it('tells the renderer only when something it shows has changed', async () => {
    const { manager, onChange } = setup({
      roster: [pc(1)],
      send: async () => statusOf('host-1'),
    });
    await manager.pollOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
    await manager.pollOnce();
    await manager.pollOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('survives a poll that throws', async () => {
    const { manager } = setup({
      roster: [pc(1), pc(2)],
      send: async (host) => {
        if (host.endsWith('.1')) throw new Error('boom');
        return statusOf('host-2');
      },
    });
    await expect(manager.pollOnce()).resolves.toBeUndefined();
    expect(manager.snapshot()[1].state).toBe('free');
  });
});

describe('lab manager: schedule', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls at once and then every 10 s, and stops', async () => {
    const { manager, sendRequest } = setup({
      roster: [pc(1)],
      send: async () => statusOf('host-1'),
    });
    manager.start();
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendRequest).toHaveBeenCalledTimes(4);
    manager.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendRequest).toHaveBeenCalledTimes(4);
  });

  it('never overlaps two rounds of polling', async () => {
    let release;
    const { manager, sendRequest } = setup({
      roster: [pc(1)],
      send: () => new Promise((resolve) => (release = () => resolve(statusOf('host-1')))),
    });
    manager.start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendRequest).toHaveBeenCalledTimes(2);
    manager.stop();
  });
});
