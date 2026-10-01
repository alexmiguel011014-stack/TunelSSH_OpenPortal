import { describe, expect, it, vi } from 'vitest';
import { createJournalFeed } from '../journal-feed.js';

const AT = Date.parse('2026-10-01T17:30:00Z');
const entry = (seq, extra = {}) => ({
  seq,
  at: AT + seq,
  type: 'student-added',
  account: 'ana',
  label: 'Ana',
  ...extra,
});

function setup({ head = 3, targets = ['100.64.0.1', '100.64.0.2'] } = {}) {
  const journal = { lastSeq: head, entries: [] };
  const service = {
    events: vi.fn(async ({ sinceSeq, limit }) => ({
      ok: true,
      events: journal.entries.filter((e) => e.seq > sinceSeq).slice(0, limit),
      lastSeq: journal.lastSeq,
      firstSeq: 1,
    })),
  };
  const push = vi.fn();
  const log = vi.fn();
  const feed = createJournalFeed({
    service,
    getTargets: vi.fn(async () => targets),
    push,
    hostIdentity: () => ({ hostId: 'host-b', hostName: 'PC-B' }),
    log,
  });
  return { feed, journal, service, push, log };
}

describe('journal feed (the live push)', () => {
  it('starts at the current end of the journal and only pushes what happens afterwards', async () => {
    const { feed, journal, push } = setup({ head: 3 });
    await feed.tick();
    expect(feed.position()).toBe(3);
    expect(push).not.toHaveBeenCalled();

    journal.entries.push(entry(4), entry(5, { type: 'quota-changed', detail: '40 GB' }));
    journal.lastSeq = 5;
    await feed.tick();
    expect(push).toHaveBeenCalledTimes(4); // 2 eventos x 2 gerentes
    expect(push).toHaveBeenNthCalledWith(
      1,
      '100.64.0.1',
      expect.objectContaining({
        v: 2,
        hostId: 'host-b',
        hostName: 'PC-B',
        seq: 4,
        type: 'student-added',
        student: { label: 'Ana', account: 'ana' },
      }),
    );
    expect(feed.position()).toBe(5);

    // Nada novo: nada empurrado.
    push.mockClear();
    await feed.tick();
    expect(push).not.toHaveBeenCalled();
  });

  it('does not push the same event twice, even when the push targets fail', async () => {
    const { feed, journal, push } = setup({ head: 0 });
    await feed.tick();
    journal.entries.push(entry(1));
    journal.lastSeq = 1;
    push.mockImplementation(() => {
      throw new Error('inalcançável');
    });
    await feed.tick();
    await feed.tick();
    expect(push).toHaveBeenCalledTimes(2); // uma vez por gerente, na primeira rodada
  });

  it('keeps its place when the service is down, and goes on when it is back', async () => {
    const { feed, journal, service, push } = setup({ head: 2 });
    await feed.tick();
    journal.entries.push(entry(3));
    journal.lastSeq = 3;
    service.events.mockResolvedValueOnce({ ok: false, error: 'service-down' });
    await feed.tick();
    expect(feed.position()).toBe(2);
    expect(push).not.toHaveBeenCalled();
    await feed.tick();
    expect(feed.position()).toBe(3);
    expect(push).toHaveBeenCalled();
  });

  it('retries the starting point when the service was down at the first look', async () => {
    const { feed, service } = setup({ head: 7 });
    service.events.mockResolvedValueOnce({ ok: false, error: 'service-down' });
    await feed.tick();
    expect(feed.position()).toBeNull();
    await feed.tick();
    expect(feed.position()).toBe(7);
  });

  it('follows a journal that started over', async () => {
    const { feed, journal, push } = setup({ head: 50 });
    await feed.tick();
    journal.lastSeq = 4;
    journal.entries = [entry(1), entry(2), entry(3), entry(4)];
    await feed.tick();
    expect(feed.position()).toBe(4);
    expect(push).not.toHaveBeenCalled();
    journal.entries.push(entry(5));
    journal.lastSeq = 5;
    await feed.tick();
    expect(push).toHaveBeenCalledWith('100.64.0.1', expect.objectContaining({ seq: 5 }));
  });

  it('skips an entry the schema refuses but still moves past it', async () => {
    const { feed, journal, push } = setup({ head: 0 });
    await feed.tick();
    journal.entries.push(entry(1, { type: 'weird-type' }), entry(2));
    journal.lastSeq = 2;
    await feed.tick();
    expect(push.mock.calls.map((call) => call[1].seq)).toEqual([2, 2]);
    expect(feed.position()).toBe(2);
  });

  it('pushes nothing when there is no manager to push to, and never overlaps two rounds', async () => {
    const { feed, journal, push } = setup({ head: 0, targets: [] });
    await feed.tick();
    journal.entries.push(entry(1));
    journal.lastSeq = 1;
    await feed.tick();
    expect(push).not.toHaveBeenCalled();
    expect(feed.position()).toBe(1);

    let release;
    const slow = setup({ head: 0 });
    slow.service.events.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, events: [], lastSeq: 0 });
        }),
    );
    const first = slow.feed.tick();
    await slow.feed.tick(); // a segunda rodada vê que a primeira não acabou
    expect(slow.service.events).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('starts and stops its timer', async () => {
    const timer = { unref: vi.fn() };
    const setTimer = vi.fn(() => timer);
    const clearTimer = vi.fn();
    const { service } = setup();
    const feed = createJournalFeed({
      service,
      getTargets: async () => [],
      push: () => {},
      hostIdentity: () => ({ hostId: 'h', hostName: 'n' }),
      setTimer,
      clearTimer,
    });
    feed.start();
    feed.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    feed.stop();
    expect(clearTimer).toHaveBeenCalledWith(timer);
  });
});
