import { describe, expect, it, vi } from 'vitest';
import { createEventLog } from '../event-log.js';
import { createLabStore } from '../lab-store.js';
import { createLabManager } from '../manager.js';
import { buildSuccess } from '../protocol.js';

const HOST_ID = 'host-1';
const AT = Date.parse('2026-10-01T17:30:00Z');
const ok = (response) => ({ ok: true, response });
const down = () => ({ ok: false, error: 'unreachable', message: 'x' });

const statusAnswer = (extra = {}) =>
  ok(
    buildSuccess('lab-status', {
      hostId: HOST_ID,
      hostName: 'PC-LAB-01',
      appVersion: '1.0.8',
      managed: true,
      service: { installed: true, running: true },
      state: 'free',
      studentCount: 1,
      lastSeq: 0,
      ...extra,
    }),
  );

const ev = (seq, extra = {}) => ({
  v: 2,
  hostId: HOST_ID,
  hostName: 'PC-LAB-01',
  seq,
  at: AT + seq * 1000,
  type: 'quota-changed',
  student: { label: 'Ana', account: 'ana' },
  detail: `${seq} GB`,
  ...extra,
});

function memoryFs() {
  const state = { text: undefined };
  return {
    existsSync: () => state.text !== undefined,
    readFileSync: () => state.text ?? '',
    appendFileSync: (_f, text) => {
      state.text = (state.text ?? '') + text;
    },
    writeFileSync: (_f, text) => {
      state.tmp = text;
    },
    renameSync: () => {
      state.text = state.tmp;
    },
    mkdirSync: () => {},
  };
}

// Um "PC B" que responde ao status com `status()` e aos pedidos de eventos com o diário `journal`.
function setup({ journal = [], firstSeq = 1, status = () => statusAnswer() } = {}) {
  const disk = {
    lab: { roster: [{ hostId: HOST_ID, name: 'PC-LAB-01', host: '100.64.0.11', enrolledAt: 1 }] },
  };
  const store = createLabStore({ read: () => structuredClone(disk), write: () => {} });
  const clock = { t: AT };
  const eventLog = createEventLog({ file: 'log.jsonl', fsApi: memoryFs(), now: () => clock.t });
  const requests = [];
  const pc = { journal, firstSeq, status, fail: false };
  const sendRequest = vi.fn(async (_host, built) => {
    const { type } = built.request;
    requests.push(built.request);
    if (pc.fail) return down();
    if (type === 'lab-status') return pc.status();
    if (type === 'lab-events') {
      const { sinceSeq, limit } = built.request;
      const events = pc.journal.filter((e) => e.seq > sinceSeq).slice(0, limit);
      return ok(
        buildSuccess('lab-events', {
          events,
          lastSeq: pc.journal.at(-1)?.seq ?? 0,
          firstSeq: pc.firstSeq,
        }),
      );
    }
    return down();
  });
  const manager = createLabManager({
    store,
    sendRequest,
    eventLog,
    isAllowedHost: () => true,
    now: () => clock.t,
  });
  const poll = async () => {
    await manager.pollOnce();
    await manager.settled();
  };
  const eventRequests = () => requests.filter((r) => r.type === 'lab-events');
  return { manager, eventLog, pc, poll, clock, requests, eventRequests, sendRequest };
}

const seqs = (eventLog, filters = {}) => eventLog.query(filters).events.map((e) => e.seq);

describe('manager: catching up by sequence number (G19-I5)', () => {
  it('asks for what is missing after having been offline, and merges it', async () => {
    const t = setup({
      journal: [1, 2, 3, 4, 5, 6].map((n) => ev(n)),
      status: () => statusAnswer({ lastSeq: 6 }),
    });
    t.eventLog.add(ev(1));
    t.eventLog.add(ev(2));
    await t.poll();
    expect(seqs(t.eventLog)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(t.eventLog.cursor(HOST_ID)).toBe(6);
    expect(t.eventRequests()).toHaveLength(1);
    expect(t.eventRequests()[0]).toMatchObject({ sinceSeq: 2, limit: 500 });
  });

  it('asks for nothing when it is level, and does not ask a PC that has no journal yet', async () => {
    const t = setup({ journal: [ev(1), ev(2)], status: () => statusAnswer({ lastSeq: 2 }) });
    t.eventLog.add(ev(1));
    t.eventLog.add(ev(2));
    await t.poll();
    expect(t.eventRequests()).toHaveLength(0);
    const empty = setup();
    await empty.poll();
    expect(empty.eventRequests()).toHaveLength(0);
  });

  it('counts an event that arrived by push and again by pull only once', async () => {
    const t = setup({ journal: [ev(1), ev(2), ev(3)], status: () => statusAnswer({ lastSeq: 3 }) });
    t.eventLog.add(ev(3)); // o push do último chegou antes
    await t.poll();
    expect(seqs(t.eventLog)).toEqual([1, 2, 3]);
    expect(t.eventLog.count()).toBe(3);
    // A pergunta partiu do cursor (0): o 3 do push não escondeu o 1 e o 2.
    expect(t.eventRequests()[0].sinceSeq).toBe(0);
  });

  it('records a gap when the PC journal rotated past where the manager had got to', async () => {
    const t = setup({
      journal: [10, 11, 12].map((n) => ev(n)),
      firstSeq: 10,
      status: () => statusAnswer({ lastSeq: 12 }),
    });
    t.eventLog.add(ev(1));
    t.eventLog.add(ev(2));
    await t.poll();
    expect(seqs(t.eventLog)).toEqual([1, 2, 10, 11, 12]);
    const { gaps } = t.eventLog.query();
    expect(gaps).toEqual([
      expect.objectContaining({ fromSeq: 3, toSeq: 9, reason: 'rotated', hostId: HOST_ID }),
    ]);
    expect(t.eventLog.cursor(HOST_ID)).toBe(12);
    // Na rodada seguinte já não há o que pedir.
    await t.poll();
    expect(t.eventRequests()).toHaveLength(1);
  });

  it('records a hole in the middle of what the PC sent', async () => {
    const t = setup({ journal: [ev(1), ev(2), ev(5)], status: () => statusAnswer({ lastSeq: 5 }) });
    await t.poll();
    expect(t.eventLog.query().gaps).toEqual([
      expect.objectContaining({ fromSeq: 3, toSeq: 4, reason: 'missing' }),
    ]);
    expect(t.eventLog.cursor(HOST_ID)).toBe(5);
  });

  it('records the part that was dropped when the PC has nothing at all after where it stood', async () => {
    const t = setup({ journal: [], firstSeq: 20, status: () => statusAnswer({ lastSeq: 25 }) });
    t.eventLog.add(ev(1));
    await t.poll();
    expect(t.eventLog.query().gaps).toEqual([
      expect.objectContaining({ fromSeq: 2, toSeq: 19, reason: 'rotated' }),
    ]);
  });

  it('pages through a long journal, 500 at a time', async () => {
    const journal = Array.from({ length: 1200 }, (_, i) => ev(i + 1));
    const t = setup({ journal, status: () => statusAnswer({ lastSeq: 1200 }) });
    await t.poll();
    expect(t.eventLog.count()).toBe(1200);
    expect(t.eventLog.cursor(HOST_ID)).toBe(1200);
    expect(t.eventRequests().map((r) => r.sinceSeq)).toEqual([0, 500, 1000]);
  });

  it('keeps only events that belong to the PC it asked, and only valid ones', async () => {
    const t = setup({
      journal: [ev(1), ev(2, { hostId: 'host-impostor' }), ev(3, { type: 'host-lost' }), ev(4)],
      status: () => statusAnswer({ lastSeq: 4 }),
    });
    await t.poll();
    expect(seqs(t.eventLog)).toEqual([1, 4]);
    expect(t.eventLog.query().events.map((e) => e.hostId)).toEqual([HOST_ID, HOST_ID]);
    // O que faltou entre 1 e 4 fica registrado como lacuna, não como evento inventado.
    expect(t.eventLog.query().gaps).toEqual([expect.objectContaining({ fromSeq: 2, toSeq: 3 })]);
  });

  it('notes that the PC journal started over instead of mixing the numbers', async () => {
    const t = setup({ journal: [ev(1)], status: () => statusAnswer({ lastSeq: 1 }) });
    for (const n of [1, 2, 3, 4, 5]) t.eventLog.add(ev(n));
    await t.poll();
    expect(t.eventRequests()).toHaveLength(0);
    expect(t.eventLog.query().gaps).toEqual([
      expect.objectContaining({ reason: 'reset', fromSeq: 2, toSeq: 5 }),
    ]);
    expect(t.eventLog.count()).toBe(5);
  });

  it('ignores an answer that is an error or from another protocol version', async () => {
    const t = setup({ journal: [ev(1)], status: () => statusAnswer({ lastSeq: 1 }) });
    t.sendRequest.mockImplementation(async (_host, built) => {
      if (built.request.type === 'lab-status') return statusAnswer({ lastSeq: 1 });
      return ok({
        ...buildSuccess('lab-events', { events: [ev(1)], lastSeq: 1, firstSeq: 1 }),
        labProtocol: 2,
      });
    });
    await t.poll();
    expect(t.eventLog.count()).toBe(0);
    t.sendRequest.mockImplementation(async (_host, built) =>
      built.request.type === 'lab-status'
        ? statusAnswer({ lastSeq: 1 })
        : ok({
            type: 'lab-response',
            request: 'lab-events',
            ok: false,
            error: 'internal',
            labProtocol: 1,
          }),
    );
    await t.poll();
    expect(t.eventLog.count()).toBe(0);
  });

  it('never runs two catch-ups for the same PC at once', async () => {
    let release;
    let eventCalls = 0;
    const t = setup({ journal: [ev(1)], status: () => statusAnswer({ lastSeq: 1 }) });
    const original = t.sendRequest.getMockImplementation();
    t.sendRequest.mockImplementation(async (host, built) => {
      if (built.request.type === 'lab-events') {
        eventCalls += 1;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return original(host, built);
    });
    await t.manager.pollOnce();
    await t.manager.pollOnce();
    await vi.waitFor(() => expect(eventCalls).toBe(1));
    release();
    await t.manager.settled();
    expect(eventCalls).toBe(1);
    expect(t.eventLog.count()).toBe(1);
  });
});

describe('manager: the PC stops answering during a reservation (G19-I7)', () => {
  const inUse = () =>
    statusAnswer({ state: 'in-use', student: { label: 'Ana', since: AT, endsAt: AT + 3600000 } });

  it('records host-lost after 3 missed polls (30 s), once, and host-back when it answers again', async () => {
    const t = setup({ status: inUse });
    await t.poll();
    expect(t.manager.snapshot()[0]).toMatchObject({ state: 'in-use' });
    t.pc.fail = true;
    await t.poll();
    await t.poll();
    expect(seqs(t.eventLog)).toEqual([]);
    expect(t.eventLog.query({ types: ['host-lost'] }).events).toHaveLength(0);
    await t.poll(); // a terceira consulta sem resposta
    const lost = t.eventLog.query({ types: ['host-lost'] }).events;
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      hostId: HOST_ID,
      hostName: 'PC-LAB-01',
      seq: 0,
      student: { label: 'Ana', account: '' },
    });
    expect(t.manager.snapshot()[0].lost).toBe(true);
    // Mais consultas sem resposta não repetem o registro.
    await t.poll();
    await t.poll();
    expect(t.eventLog.query({ types: ['host-lost'] }).events).toHaveLength(1);
    t.clock.t += 60000;
    t.pc.fail = false;
    await t.poll();
    expect(t.eventLog.query({ types: ['host-back'] }).events).toHaveLength(1);
    expect(t.manager.snapshot()[0].lost).toBeUndefined();
    expect(t.manager.snapshot()[0].state).toBe('in-use');
  });

  it('is silent for a free PC that goes quiet (nobody is using it)', async () => {
    const t = setup();
    await t.poll();
    t.pc.fail = true;
    for (let i = 0; i < 5; i += 1) await t.poll();
    expect(t.eventLog.query({ types: ['host-lost', 'host-back'] }).events).toEqual([]);
    expect(t.manager.snapshot()[0].state).toBe('offline');
    expect(t.manager.snapshot()[0].lost).toBeUndefined();
  });

  it('counts a reserved PC (the student has not signed in yet) as an active reservation', async () => {
    const t = setup({
      status: () =>
        statusAnswer({
          state: 'reserved',
          student: { label: 'João', since: AT, endsAt: AT + 3600000 },
        }),
    });
    await t.poll();
    t.pc.fail = true;
    for (let i = 0; i < 3; i += 1) await t.poll();
    expect(t.eventLog.query({ types: ['host-lost'] }).events).toHaveLength(1);
  });

  it('a short blip of one or two missed polls records nothing', async () => {
    const t = setup({ status: inUse });
    await t.poll();
    t.pc.fail = true;
    await t.poll();
    await t.poll();
    t.pc.fail = false;
    await t.poll();
    expect(t.eventLog.query({ types: ['host-lost', 'host-back'] }).events).toEqual([]);
  });

  it('records again when the PC is lost a second time', async () => {
    const t = setup({ status: inUse });
    await t.poll();
    for (let round = 0; round < 2; round += 1) {
      t.clock.t += 120000;
      t.pc.fail = true;
      for (let i = 0; i < 3; i += 1) await t.poll();
      t.clock.t += 120000;
      t.pc.fail = false;
      await t.poll();
    }
    expect(t.eventLog.query({ types: ['host-lost'] }).events).toHaveLength(2);
    expect(t.eventLog.query({ types: ['host-back'] }).events).toHaveLength(2);
  });
});

describe('manager without an event log', () => {
  it('still polls the status and does not ask for events', async () => {
    const disk = {
      lab: { roster: [{ hostId: HOST_ID, name: 'PC', host: '100.64.0.11', enrolledAt: 1 }] },
    };
    const store = createLabStore({ read: () => structuredClone(disk), write: () => {} });
    const sendRequest = vi.fn(async () => statusAnswer({ lastSeq: 9 }));
    const manager = createLabManager({ store, sendRequest, isAllowedHost: () => true });
    await manager.pollOnce();
    await manager.settled();
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()[0].state).toBe('free');
  });
});
