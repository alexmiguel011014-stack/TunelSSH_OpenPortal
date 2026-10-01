import { describe, expect, it, vi } from 'vitest';
import { createActivityReceiver } from '../activity-receiver.js';

const AT = Date.parse('2026-10-01T17:30:00Z');
const ROSTER = [
  { hostId: 'host-b', name: 'PC-B', host: '100.64.0.11' },
  { hostId: 'host-c', name: 'PC-C', host: '100.64.0.12' },
];
const v2 = (extra = {}) => ({
  v: 2,
  hostId: 'host-b',
  hostName: 'PC-B',
  seq: 1,
  at: AT,
  type: 'session-logon',
  student: { label: 'Ana', account: 'ana' },
  sourceIp: '100.64.0.9',
  ...extra,
});
const legacy = (extra = {}) => ({
  identity: 'aluno@escola.com',
  machineName: 'PC-A',
  startedAt: AT,
  endedAt: AT + 1000,
  durationMs: 1000,
  filesTransferred: 2,
  ...extra,
});

function setup({ identities = {}, trusted = ['prof@escola.com'], clock = { t: 1000 } } = {}) {
  const added = [];
  const eventLog = {
    add: vi.fn((event) => {
      added.push(event);
      return { added: true };
    }),
  };
  const onLegacy = vi.fn();
  const log = vi.fn();
  const receiver = createActivityReceiver({
    getRoster: () => ROSTER,
    getTrustedLogins: () => trusted,
    resolveIdentity: vi.fn(async (ip) => identities[ip] ?? 'unknown'),
    eventLog,
    onLegacy,
    log,
    now: () => clock.t,
  });
  return { receiver, eventLog, added, onLegacy, log, clock };
}

describe('activity receiver: v2 events (G19-I4)', () => {
  it('stores an event from the roster address that carries that PC id', async () => {
    const { receiver, added } = setup();
    expect(await receiver.receive({ event: v2(), remoteAddress: '::ffff:100.64.0.11' })).toEqual({
      accepted: true,
      kind: 'v2',
      added: true,
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ hostId: 'host-b', seq: 1, type: 'session-logon' });
  });

  it('drops a forged event from an address that is not in the roster', async () => {
    const { receiver, eventLog, log } = setup();
    const result = await receiver.receive({ event: v2(), remoteAddress: '100.64.0.99' });
    expect(result).toEqual({ accepted: false, reason: 'not-in-roster' });
    expect(eventLog.add).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not-in-roster'));
  });

  it('drops an event from a roster address that claims another PC', async () => {
    const { receiver, eventLog } = setup();
    // O PC C (100.64.0.12) tenta passar por PC B.
    const result = await receiver.receive({ event: v2(), remoteAddress: '100.64.0.12' });
    expect(result).toEqual({ accepted: false, reason: 'host-mismatch' });
    expect(eventLog.add).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed event', v2({ seq: 'x' })],
    ['an unknown type', v2({ type: 'teleport' })],
    ['a PC claiming host-lost (only the manager creates it)', v2({ type: 'host-lost' })],
    ['a bad version', { ...v2(), v: 3 }],
    ['a non-object', 'event'],
    ['null', null],
  ])('drops %s even from a roster address', async (_name, event) => {
    const { receiver, eventLog } = setup();
    const result = await receiver.receive({ event, remoteAddress: '100.64.0.11' });
    expect(result.accepted).toBe(false);
    expect(eventLog.add).not.toHaveBeenCalled();
  });

  it('drops an event with no origin', async () => {
    const { receiver, eventLog } = setup();
    expect(await receiver.receive({ event: v2(), remoteAddress: '' })).toEqual({
      accepted: false,
      reason: 'no-origin',
    });
    expect(eventLog.add).not.toHaveBeenCalled();
  });

  it('tells a duplicate from a new event but accepts both', async () => {
    const { receiver, eventLog } = setup();
    eventLog.add.mockReturnValueOnce({ added: false, duplicate: true });
    expect(await receiver.receive({ event: v2(), remoteAddress: '100.64.0.11' })).toEqual({
      accepted: true,
      kind: 'v2',
      added: false,
    });
  });
});

describe('activity receiver: GOALS 4 events', () => {
  it('forwards an old event from a login the app already knows', async () => {
    const { receiver, onLegacy } = setup({ identities: { '100.64.0.50': 'prof@escola.com' } });
    const result = await receiver.receive({ event: legacy(), remoteAddress: '100.64.0.50' });
    expect(result).toEqual({ accepted: true, kind: 'legacy' });
    expect(onLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ identity: 'aluno@escola.com' }),
    );
  });

  it('drops one from a login nobody listed, from an unconfirmed identity, or from a stranger', async () => {
    const { receiver, onLegacy } = setup({
      identities: { '100.64.0.60': 'estranho@outra.com' },
    });
    expect(await receiver.receive({ event: legacy(), remoteAddress: '100.64.0.60' })).toEqual({
      accepted: false,
      reason: 'untrusted-sender',
    });
    expect(await receiver.receive({ event: legacy(), remoteAddress: '100.64.0.61' })).toEqual({
      accepted: false,
      reason: 'untrusted-sender',
    });
    expect(onLegacy).not.toHaveBeenCalled();
  });

  it('drops an old event that is missing who and where, and survives a failing identity lookup', async () => {
    const { receiver, onLegacy } = setup({ identities: { '100.64.0.50': 'prof@escola.com' } });
    expect(
      (await receiver.receive({ event: { identity: 'a' }, remoteAddress: '100.64.0.50' })).accepted,
    ).toBe(false);
    const broken = createActivityReceiver({
      getRoster: () => ROSTER,
      getTrustedLogins: () => ['prof@escola.com'],
      resolveIdentity: async () => {
        throw new Error('tailscale fora do ar');
      },
      eventLog: { add: vi.fn() },
      onLegacy,
    });
    expect(await broken.receive({ event: legacy(), remoteAddress: '100.64.0.50' })).toEqual({
      accepted: false,
      reason: 'untrusted-sender',
    });
    expect(onLegacy).not.toHaveBeenCalled();
  });

  it('does not let a lab roster address skip the login check for an old event', async () => {
    const { receiver, onLegacy } = setup();
    // 100.64.0.11 é um PC da lista, mas um evento sem `v` ainda precisa de login conhecido.
    expect(
      (await receiver.receive({ event: legacy(), remoteAddress: '100.64.0.11' })).accepted,
    ).toBe(false);
    expect(onLegacy).not.toHaveBeenCalled();
  });
});

describe('activity receiver: counting and logging', () => {
  it('counts what it accepts and what it drops, by reason', async () => {
    const { receiver } = setup();
    await receiver.receive({ event: v2(), remoteAddress: '100.64.0.11' });
    await receiver.receive({ event: v2({ seq: 2 }), remoteAddress: '100.64.0.99' });
    await receiver.receive({ event: v2({ seq: 3 }), remoteAddress: '100.64.0.99' });
    await receiver.receive({ event: 'x', remoteAddress: '100.64.0.11' });
    expect(receiver.stats()).toEqual({
      accepted: 1,
      dropped: 3,
      reasons: { 'not-in-roster': 2, malformed: 1 },
    });
  });

  it('writes one log line per origin and reason every 30 seconds, not one per attempt', async () => {
    const { receiver, log, clock } = setup();
    for (let i = 0; i < 50; i += 1) {
      await receiver.receive({ event: v2({ seq: i + 1 }), remoteAddress: '100.64.0.99' });
    }
    expect(log).toHaveBeenCalledTimes(1);
    clock.t += 31_000;
    await receiver.receive({ event: v2(), remoteAddress: '100.64.0.99' });
    expect(log).toHaveBeenCalledTimes(2);
    await receiver.receive({ event: v2(), remoteAddress: '100.64.0.98' });
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('never throws, even if the store does', async () => {
    const { receiver, eventLog } = setup();
    eventLog.add.mockImplementation(() => {
      throw new Error('disco');
    });
    expect(await receiver.receive({ event: v2(), remoteAddress: '100.64.0.11' })).toEqual({
      accepted: false,
      reason: 'error',
    });
  });
});
