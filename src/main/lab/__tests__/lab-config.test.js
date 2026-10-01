import { describe, it, expect } from 'vitest';
import {
  MAX_MANAGERS,
  MAX_ROSTER,
  addManager,
  effectiveAllowedUsers,
  effectiveReportTo,
  guardLabKeys,
  isLabModeOn,
  mergeLabFromRenderer,
  normalizeLogin,
  readLab,
  removeManager,
  removeRosterEntry,
  upsertRosterEntry,
} from '../lab-config.js';
import { createLabStore } from '../lab-store.js';

const pc = (n, extra = {}) => ({
  hostId: `host-${n}`,
  name: `PC ${n}`,
  host: `100.64.0.${n}`,
  enrolledAt: 1000 + n,
  ...extra,
});

describe('readLab', () => {
  it('returns safe defaults for a config with no lab section', () => {
    expect(readLab({})).toEqual({
      managers: [],
      managed: false,
      mode: false,
      roster: [],
      logRetentionDays: 180,
    });
    expect(readLab(undefined)).toEqual({
      managers: [],
      managed: false,
      mode: false,
      roster: [],
      logRetentionDays: 180,
    });
    expect(readLab({ lab: 'oops' }).managed).toBe(false);
  });

  it('derives managed from the managers and ignores a stored managed flag', () => {
    expect(readLab({ lab: { managed: true, managers: [] } }).managed).toBe(false);
    expect(readLab({ lab: { managers: ['prof@x.com'] } }).managed).toBe(true);
  });

  it('cleans managers: dedupe, unknown, blanks, whitespace, non-strings', () => {
    const lab = readLab({
      lab: {
        managers: ['prof@x.com', 'prof@x.com', 'unknown', '', '  ', 'a b@x.com', 7, null],
      },
    });
    expect(lab.managers).toEqual(['prof@x.com']);
  });

  it('caps managers and roster', () => {
    const managers = Array.from({ length: MAX_MANAGERS + 5 }, (_, i) => `m${i}@x.com`);
    expect(readLab({ lab: { managers } }).managers).toHaveLength(MAX_MANAGERS);
    const roster = Array.from({ length: MAX_ROSTER + 5 }, (_, i) =>
      pc(i % 250, { hostId: `h${i}` }),
    );
    expect(readLab({ lab: { roster } }).roster).toHaveLength(MAX_ROSTER);
  });

  it('drops roster entries with a bad address or a duplicate hostId', () => {
    const lab = readLab({
      lab: {
        roster: [pc(1), pc(1), pc(2, { host: 'not-an-ip' }), pc(3, { host: '300.1.1.1' }), 'x'],
      },
    });
    expect(lab.roster.map((entry) => entry.hostId)).toEqual(['host-1']);
  });
});

describe('guardLabKeys (what a saveConfig from the renderer can change)', () => {
  const existing = {
    hostId: 'real-host-id',
    allowedUsers: ['a@x.com'],
    lab: { mode: false, managers: ['prof@x.com'], roster: [pc(1)] },
  };

  it('keeps the hostId and ignores one sent by the renderer', () => {
    const merged = guardLabKeys(existing, { ...existing, hostId: 'forged' });
    expect(merged.hostId).toBe('real-host-id');
  });

  it('does not let the renderer create a hostId', () => {
    const merged = guardLabKeys({}, { hostId: 'forged' });
    expect(merged).not.toHaveProperty('hostId');
  });

  it('does not let saveConfig add a manager', () => {
    const merged = guardLabKeys(existing, {
      ...existing,
      lab: { ...existing.lab, managers: ['prof@x.com', 'evil@x.com'] },
    });
    expect(merged.lab.managers).toEqual(['prof@x.com']);
  });

  it('does not let saveConfig create the first manager on an unmanaged PC', () => {
    const merged = guardLabKeys({}, { lab: { managers: ['evil@x.com'], managed: true } });
    expect(readLab(merged).managers).toEqual([]);
    expect(readLab(merged).managed).toBe(false);
  });

  it('does not let saveConfig remove managers or replace the roster', () => {
    const merged = guardLabKeys(existing, {
      ...existing,
      lab: { managers: [], roster: [] },
    });
    expect(merged.lab.managers).toEqual(['prof@x.com']);
    expect(merged.lab.roster).toEqual([pc(1)]);
  });

  it('accepts lab.mode from the renderer', () => {
    const merged = guardLabKeys(existing, { ...existing, lab: { mode: true } });
    expect(merged.lab.mode).toBe(true);
    expect(merged.lab.managers).toEqual(['prof@x.com']);
  });

  it('ignores a non-boolean mode', () => {
    const merged = guardLabKeys(existing, {
      ...existing,
      lab: { mode: 'yes' },
    });
    expect(merged.lab.mode).toBe(false);
  });

  it('leaves the file free of a lab section when nobody ever set one', () => {
    expect(guardLabKeys({}, { machines: [] })).toEqual({ machines: [] });
  });

  it('keeps unrelated keys untouched', () => {
    const merged = guardLabKeys(existing, {
      ...existing,
      allowedUsers: ['b@x.com'],
      proxyPort: 1,
    });
    expect(merged.allowedUsers).toEqual(['b@x.com']);
    expect(merged.proxyPort).toBe(1);
  });

  it('treats a save that does not mention lab as no change', () => {
    const withoutLab = { ...existing };
    delete withoutLab.lab;
    const merged = guardLabKeys(existing, { ...withoutLab, lab: existing.lab });
    expect(merged.lab).toEqual(mergeLabFromRenderer(existing.lab, undefined));
    expect(merged.lab.managers).toEqual(['prof@x.com']);
  });
});

describe('effective lists', () => {
  const config = {
    allowedUsers: ['a@x.com', 'prof@x.com'],
    reportTo: ['boss@x.com'],
    lab: { managers: ['prof@x.com', 'ta@x.com'] },
  };

  it('allowedUsers ∪ managers, without duplicates', () => {
    expect(effectiveAllowedUsers(config)).toEqual(['a@x.com', 'prof@x.com', 'ta@x.com']);
  });

  it('reportTo ∪ managers, without duplicates', () => {
    expect(effectiveReportTo(config)).toEqual(['boss@x.com', 'prof@x.com', 'ta@x.com']);
  });

  it('works with missing lists', () => {
    expect(effectiveAllowedUsers({})).toEqual([]);
    expect(effectiveReportTo({ reportTo: 'oops' })).toEqual([]);
    expect(
      effectiveAllowedUsers({
        allowedUsers: 'oops',
        lab: { managers: ['m@x.com'] },
      }),
    ).toEqual(['m@x.com']);
  });

  it('never lets "unknown" become an approved identity', () => {
    expect(effectiveAllowedUsers({ lab: { managers: ['unknown'] } })).toEqual([]);
  });
});

describe('managers and roster edits', () => {
  it('adds a manager once and turns managed on', () => {
    const first = addManager({}, 'prof@x.com');
    expect(first).toMatchObject({ ok: true, added: true });
    expect(first.lab).toMatchObject({
      managers: ['prof@x.com'],
      managed: true,
    });
    const again = addManager({ lab: first.lab }, 'prof@x.com');
    expect(again).toMatchObject({ ok: true, added: false });
  });

  it('refuses invalid logins and a full list', () => {
    expect(addManager({}, 'unknown')).toMatchObject({
      ok: false,
      error: 'invalid',
    });
    expect(addManager({}, 5)).toMatchObject({ ok: false, error: 'invalid' });
    const managers = Array.from({ length: MAX_MANAGERS }, (_, i) => `m${i}@x.com`);
    expect(addManager({ lab: { managers } }, 'one-more@x.com')).toMatchObject({
      ok: false,
      error: 'full',
    });
  });

  it('removing the last manager turns managed off', () => {
    const result = removeManager({ lab: { managers: ['prof@x.com'] } }, 'prof@x.com');
    expect(result.removed).toBe(true);
    expect(result.lab).toMatchObject({ managers: [], managed: false });
    expect(removeManager({ lab: { managers: ['a@x.com'] } }, 'b@x.com').removed).toBe(false);
  });

  it('updates a roster entry instead of duplicating it, keeping enrolledAt', () => {
    const first = upsertRosterEntry({}, pc(1));
    const moved = upsertRosterEntry(
      { lab: first.lab },
      pc(1, { host: '100.64.0.99', enrolledAt: 5 }),
    );
    expect(moved).toMatchObject({ ok: true, added: false });
    expect(moved.lab.roster).toEqual([pc(1, { host: '100.64.0.99' })]);
  });

  it('caps the roster at 50 and rejects bad entries', () => {
    let config = {};
    for (let i = 1; i <= MAX_ROSTER; i++) {
      const result = upsertRosterEntry(config, pc(i % 250, { hostId: `h${i}` }));
      expect(result.ok).toBe(true);
      config = { lab: result.lab };
    }
    expect(upsertRosterEntry(config, pc(1, { hostId: 'extra' }))).toMatchObject({
      ok: false,
      error: 'full',
    });
    expect(upsertRosterEntry({}, { hostId: 'x', host: 'nope' })).toMatchObject({
      ok: false,
      error: 'invalid',
    });
  });

  it('removes a roster entry by hostId', () => {
    const config = { lab: { roster: [pc(1), pc(2)] } };
    const result = removeRosterEntry(config, 'host-1');
    expect(result.removed).toBe(true);
    expect(result.lab.roster.map((entry) => entry.hostId)).toEqual(['host-2']);
    expect(removeRosterEntry(config, 'nope').removed).toBe(false);
  });
});

describe('isLabModeOn / normalizeLogin', () => {
  it('is on when the screen is enabled or the PC is managed', () => {
    expect(isLabModeOn({})).toBe(false);
    expect(isLabModeOn({ lab: { mode: true } })).toBe(true);
    expect(isLabModeOn({ lab: { managers: ['p@x.com'] } })).toBe(true);
  });

  it('keeps a login exactly as given, minus surrounding blanks', () => {
    expect(normalizeLogin('  Prof@X.com ')).toBe('Prof@X.com');
    expect(normalizeLogin('')).toBe('');
    expect(normalizeLogin('unknown')).toBe('');
  });
});

describe('createLabStore', () => {
  function memory(initial = {}) {
    let file = initial;
    return {
      read: () => structuredClone(file),
      write: (next) => {
        file = structuredClone(next);
      },
      peek: () => file,
    };
  }

  it('creates the hostId once and keeps it', () => {
    const disk = memory({ proxyPort: 1 });
    let n = 0;
    const store = createLabStore({ ...disk, randomUUID: () => `uuid-${++n}` });
    expect(store.getHostId()).toBe('uuid-1');
    expect(store.getHostId()).toBe('uuid-1');
    expect(disk.peek()).toMatchObject({ hostId: 'uuid-1', proxyPort: 1 });
  });

  it('persists managers without touching other keys, and removes them', () => {
    const disk = memory({ allowedUsers: ['a@x.com'] });
    const store = createLabStore(disk);
    expect(store.addManager('prof@x.com')).toMatchObject({
      ok: true,
      added: true,
    });
    expect(disk.peek().lab.managers).toEqual(['prof@x.com']);
    expect(disk.peek().allowedUsers).toEqual(['a@x.com']);
    expect(store.getLab().managed).toBe(true);
    expect(store.removeManager('prof@x.com').removed).toBe(true);
    expect(store.getLab().managed).toBe(false);
  });

  it('does not write when nothing changed', () => {
    let writes = 0;
    const disk = memory({ lab: { managers: ['prof@x.com'] } });
    const store = createLabStore({
      read: disk.read,
      write: (next) => {
        writes++;
        disk.write(next);
      },
    });
    store.addManager('prof@x.com');
    store.removeManager('nobody@x.com');
    store.removeRosterEntry('nope');
    expect(writes).toBe(0);
  });

  it('persists the roster', () => {
    const disk = memory();
    const store = createLabStore(disk);
    expect(store.upsertRosterEntry(pc(1)).ok).toBe(true);
    expect(store.upsertRosterEntry({ hostId: 'bad' }).ok).toBe(false);
    expect(store.getLab().roster).toEqual([pc(1)]);
    expect(store.removeRosterEntry('host-1').removed).toBe(true);
    expect(store.getLab().roster).toEqual([]);
  });
});

describe('lab.logRetentionDays (G19-I6)', () => {
  it('defaults to 180 days and clamps whatever is stored to 1..3650', () => {
    expect(readLab({ lab: {} }).logRetentionDays).toBe(180);
    expect(readLab({ lab: { logRetentionDays: 30 } }).logRetentionDays).toBe(30);
    expect(readLab({ lab: { logRetentionDays: 0 } }).logRetentionDays).toBe(1);
    expect(readLab({ lab: { logRetentionDays: 99999 } }).logRetentionDays).toBe(3650);
    expect(readLab({ lab: { logRetentionDays: 'abc' } }).logRetentionDays).toBe(180);
    expect(readLab({ lab: { logRetentionDays: 45.6 } }).logRetentionDays).toBe(46);
  });

  it('is kept when the renderer saves the config, and the renderer cannot change it', () => {
    const existing = { lab: { mode: false, managers: [], roster: [], logRetentionDays: 90 } };
    const merged = mergeLabFromRenderer(existing.lab, { mode: true, logRetentionDays: 1 });
    expect(merged.mode).toBe(true);
    expect(merged.logRetentionDays).toBe(90);
  });
});

describe('lab store: setLogRetentionDays', () => {
  it('saves the clamped number of days and leaves managers and roster as they were', () => {
    let disk = {
      lab: {
        mode: true,
        managers: ['prof@escola.com'],
        roster: [{ hostId: 'h1', name: 'PC', host: '100.64.0.11', enrolledAt: 1 }],
      },
    };
    const store = createLabStore({
      read: () => structuredClone(disk),
      write: (next) => {
        disk = structuredClone(next);
      },
    });
    expect(store.setLogRetentionDays(60)).toBe(60);
    expect(store.getLab()).toMatchObject({
      mode: true,
      managers: ['prof@escola.com'],
      logRetentionDays: 60,
    });
    expect(store.getLab().roster).toHaveLength(1);
    expect(store.setLogRetentionDays(0)).toBe(1);
    expect(store.setLogRetentionDays(100000)).toBe(3650);
    expect(store.setLogRetentionDays(undefined)).toBe(180);
  });
});
