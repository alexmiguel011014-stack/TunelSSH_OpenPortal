import { describe, expect, it, vi } from 'vitest';
import { createEventLog } from '../event-log.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const FILE = 'C:/dados/lab-log.jsonl';

function memoryFs(initial) {
  const state = { text: initial, failAppend: false, writes: 0 };
  return {
    state,
    existsSync: () => state.text !== undefined,
    readFileSync: () => state.text ?? '',
    appendFileSync: (_file, text) => {
      if (state.failAppend) throw new Error('disco cheio');
      state.text = (state.text ?? '') + text;
    },
    writeFileSync: (_file, text) => {
      state.writes += 1;
      state.tmp = text;
    },
    renameSync: () => {
      state.text = state.tmp;
    },
    mkdirSync: () => {},
  };
}

const ev = (seq, extra = {}) => ({
  v: 2,
  hostId: 'host-b',
  hostName: 'PC-B',
  seq,
  at: T0 + seq * 60000,
  type: 'session-logon',
  student: { label: 'Ana Souza', account: 'anasouza' },
  reservationId: 'resv0001resv0001',
  sourceIp: '100.64.0.9',
  ...extra,
});

function setup({ initial, now = T0 + DAY } = {}) {
  const fsApi = memoryFs(initial);
  const clock = { t: now };
  const onChange = vi.fn();
  const log = vi.fn();
  const eventLog = createEventLog({ file: FILE, fsApi, now: () => clock.t, onChange, log });
  return { eventLog, fsApi, clock, onChange, log };
}

describe('event log: storing and merging', () => {
  it('stores an event once per (hostId, seq), however many times it arrives', () => {
    const { eventLog, fsApi, onChange } = setup();
    expect(eventLog.add(ev(1))).toEqual({ added: true });
    // O mesmo evento por push e depois por consulta.
    expect(eventLog.add(ev(1))).toMatchObject({ added: false, duplicate: true });
    expect(eventLog.add(ev(1, { detail: 'outro texto' }))).toMatchObject({ added: false });
    expect(eventLog.count()).toBe(1);
    expect(fsApi.state.text.trim().split('\n')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Outro PC pode ter o mesmo número.
    expect(eventLog.add(ev(1, { hostId: 'host-c' })).added).toBe(true);
    expect(eventLog.count()).toBe(2);
  });

  it('refuses an invalid event without storing anything', () => {
    const { eventLog, fsApi } = setup();
    expect(eventLog.add({ v: 2 })).toMatchObject({ added: false, error: expect.any(String) });
    expect(eventLog.add(ev(0))).toMatchObject({ added: false });
    expect(eventLog.count()).toBe(0);
    expect(fsApi.state.text).toBeUndefined();
  });

  it('survives a disk that refuses to write, keeping the event in memory', () => {
    const { eventLog, fsApi, log } = setup();
    fsApi.state.failAppend = true;
    expect(eventLog.add(ev(1)).added).toBe(true);
    expect(eventLog.count()).toBe(1);
    expect(log).toHaveBeenCalled();
  });

  it('keeps host-lost and host-back that the manager created, once each', () => {
    const { eventLog } = setup();
    const lost = ev(0, {
      type: 'host-lost',
      student: undefined,
      reservationId: undefined,
      sourceIp: undefined,
    });
    expect(eventLog.add(lost).added).toBe(true);
    expect(eventLog.add(lost).added).toBe(false);
    expect(eventLog.add({ ...lost, at: lost.at + 1000 }).added).toBe(true);
    expect(eventLog.cursor('host-b')).toBe(0);
  });

  it('comes back from the file after a restart, skipping corrupt lines and a BOM', () => {
    const first = setup();
    first.eventLog.add(ev(1));
    first.eventLog.add(ev(2, { type: 'session-logoff' }));
    first.eventLog.addGap({
      hostId: 'host-b',
      hostName: 'PC-B',
      fromSeq: 3,
      toSeq: 4,
      reason: 'rotated',
    });
    const text = `\uFEFF${first.fsApi.state.text}{"kind":"event","event":{"v":2\n{lixo\n\n[1,2]\n{"kind":"event","event":{"v":9}}\n{"kind":"mistery"}\n`;
    const { eventLog } = setup({ initial: text });
    expect(eventLog.count()).toBe(2);
    expect(eventLog.query().gaps).toHaveLength(1);
    expect(eventLog.cursor('host-b')).toBe(4);
    expect(eventLog.add(ev(1)).added).toBe(false);
  });
});

describe('event log: the cursor (what to ask the PC for)', () => {
  it('moves only over a complete sequence, and a push ahead of a hole does not hide the hole', () => {
    const { eventLog } = setup();
    for (const seq of [1, 2, 4]) eventLog.add(ev(seq));
    expect(eventLog.cursor('host-b')).toBe(2);
    // Um push do evento 10 chega antes de 3, 5..9: o cursor continua em 2.
    eventLog.add(ev(10));
    expect(eventLog.cursor('host-b')).toBe(2);
    eventLog.add(ev(3));
    expect(eventLog.cursor('host-b')).toBe(4);
    for (const seq of [5, 6, 7, 8, 9]) eventLog.add(ev(seq));
    expect(eventLog.cursor('host-b')).toBe(10);
    expect(eventLog.cursor('desconhecido')).toBe(0);
  });

  it('treats a recorded gap as handled, so the log does not ask for what the PC no longer has', () => {
    const { eventLog } = setup();
    eventLog.add(ev(1));
    expect(
      eventLog.addGap({
        hostId: 'host-b',
        hostName: 'PC-B',
        fromSeq: 2,
        toSeq: 9,
        reason: 'rotated',
      }),
    ).toBe(true);
    expect(eventLog.cursor('host-b')).toBe(9);
    eventLog.add(ev(10));
    expect(eventLog.cursor('host-b')).toBe(10);
    // A mesma lacuna não é gravada duas vezes; lacunas absurdas são recusadas.
    expect(eventLog.addGap({ hostId: 'host-b', fromSeq: 2, toSeq: 9 })).toBe(false);
    expect(eventLog.addGap({ hostId: 'host-b', fromSeq: 5, toSeq: 2 })).toBe(false);
    expect(eventLog.addGap({ hostId: 'host-b', fromSeq: 0, toSeq: 2 })).toBe(false);
    expect(eventLog.addGap({ hostId: '', fromSeq: 1, toSeq: 2 })).toBe(false);
    expect(eventLog.addGap({ hostId: 'host-b', fromSeq: 1, toSeq: 9_999_999 })).toBe(false);
  });

  it('keeps each PC apart', () => {
    const { eventLog } = setup();
    eventLog.add(ev(1));
    eventLog.add(ev(2));
    eventLog.add(ev(1, { hostId: 'host-c' }));
    expect(eventLog.cursor('host-b')).toBe(2);
    expect(eventLog.cursor('host-c')).toBe(1);
  });
});

describe('event log: queries', () => {
  function filled() {
    const ctx = setup();
    ctx.eventLog.add(ev(1, { type: 'reservation-start' }));
    ctx.eventLog.add(ev(2));
    ctx.eventLog.add(
      ev(3, { student: { label: 'João', account: 'joao' }, hostId: 'host-c', hostName: 'PC-C' }),
    );
    ctx.eventLog.add(ev(4, { type: 'reservation-end', endReason: 'deadline', at: T0 + 3 * DAY }));
    return ctx;
  }

  it('filters by student (account or part of the name, any case), PC, period and type', () => {
    const { eventLog } = filled();
    expect(eventLog.query().events).toHaveLength(4);
    expect(eventLog.query({ student: 'joao' }).events.map((e) => e.seq)).toEqual([3]);
    expect(eventLog.query({ student: 'ANA' }).events.map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(eventLog.query({ student: 'souza' }).events).toHaveLength(3);
    expect(eventLog.query({ student: 'ninguém' }).events).toEqual([]);
    expect(eventLog.query({ hostId: 'host-c' }).events.map((e) => e.seq)).toEqual([3]);
    expect(
      eventLog.query({ types: ['reservation-start', 'reservation-end'] }).events.map((e) => e.seq),
    ).toEqual([1, 4]);
    // O período é inclusivo nas duas pontas.
    expect(
      eventLog.query({ from: T0 + 2 * 60000, to: T0 + 3 * 60000 }).events.map((e) => e.seq),
    ).toEqual([2, 3]);
    expect(eventLog.query({ from: T0 + 2 * DAY }).events.map((e) => e.seq)).toEqual([4]);
    expect(
      eventLog
        .query({ hostId: 'host-b', student: 'ana', types: ['session-logon'] })
        .events.map((e) => e.seq),
    ).toEqual([2]);
  });

  it('returns oldest first with the time it was received, and the gaps of the PC asked for', () => {
    const { eventLog, clock } = filled();
    clock.t += 5000;
    eventLog.addGap({ hostId: 'host-b', hostName: 'PC-B', fromSeq: 5, toSeq: 6 });
    eventLog.addGap({ hostId: 'host-c', hostName: 'PC-C', fromSeq: 4, toSeq: 4 });
    const all = eventLog.query();
    expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(all.events[0].receivedAt).toBe(T0 + DAY);
    expect(all.gaps).toHaveLength(2);
    expect(eventLog.query({ hostId: 'host-b' }).gaps.map((g) => g.hostId)).toEqual(['host-b']);
  });

  it('lists the PCs and students that appear, for the filters', () => {
    const { eventLog } = filled();
    expect(eventLog.facets()).toEqual({
      hosts: [
        { hostId: 'host-b', hostName: 'PC-B' },
        { hostId: 'host-c', hostName: 'PC-C' },
      ],
      students: [
        { account: 'anasouza', label: 'Ana Souza' },
        { account: 'joao', label: 'João' },
      ],
    });
  });

  it('exports the filtered rows as a spreadsheet-ready CSV', () => {
    const { eventLog } = filled();
    const csv = eventLog.exportCsv({ student: 'joao' }, { timeZone: 'America/Sao_Paulo' });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const rows = csv.trim().split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1].split(';')[2]).toBe('PC-C');
    expect(rows[1]).toContain('João');
  });
});

describe('event log: retention', () => {
  function aged() {
    const ctx = setup({ now: T0 + 400 * DAY });
    // Eventos de 400 dias, 200 dias e 10 dias atrás.
    ctx.eventLog.add(ev(1, { at: T0 }));
    ctx.eventLog.add(ev(2, { at: T0 + 200 * DAY }));
    ctx.eventLog.add(ev(3, { at: T0 + 390 * DAY }));
    ctx.eventLog.add(ev(4, { at: T0 + 100 * DAY, hostId: 'host-c', hostName: 'PC-C' }));
    return ctx;
  }

  it('removes what is older than the retention and rewrites the file', () => {
    const { eventLog, fsApi } = aged();
    expect(eventLog.applyRetention(180)).toBe(2);
    expect(eventLog.query({ hostId: 'host-b' }).events.map((e) => e.seq)).toEqual([3]);
    expect(fsApi.state.writes).toBe(1);
    // Um PC sem nenhum evento recente mantém o último (a sequência dele não some).
    expect(eventLog.query({ hostId: 'host-c' }).events.map((e) => e.seq)).toEqual([4]);
    // De novo: nada a fazer.
    expect(eventLog.applyRetention(180)).toBe(0);
  });

  it('keeps the cursor, so the log does not ask the PC for what it just dropped', () => {
    const { eventLog } = aged();
    expect(eventLog.cursor('host-b')).toBe(3);
    eventLog.applyRetention(180);
    expect(eventLog.cursor('host-b')).toBe(3);
  });

  it('survives a restart after a retention pass', () => {
    const { eventLog, fsApi, clock } = aged();
    eventLog.applyRetention(180);
    const again = createEventLog({ file: FILE, fsApi, now: () => clock.t });
    expect(again.count()).toBe(2);
    expect(again.cursor('host-b')).toBe(3);
    expect(again.cursor('host-c')).toBe(0);
    expect(again.add(ev(3, { at: T0 + 390 * DAY })).added).toBe(false);
  });

  it('clamps the retention setting to 1..3650 days and defaults to 180', () => {
    const { eventLog } = setup();
    expect(eventLog.getRetentionDays()).toBe(180);
    expect(eventLog.setRetentionDays(0)).toBe(1);
    expect(eventLog.setRetentionDays(99999)).toBe(3650);
    expect(eventLog.setRetentionDays(90.4)).toBe(90);
    expect(eventLog.setRetentionDays(NaN)).toBe(180);
    expect(eventLog.setRetentionDays('abc')).toBe(180);
  });

  it('does nothing, and writes nothing, when nothing is old', () => {
    const { eventLog, fsApi } = setup();
    eventLog.add(ev(1));
    expect(eventLog.applyRetention(180)).toBe(0);
    expect(fsApi.state.writes).toBe(0);
  });
});
