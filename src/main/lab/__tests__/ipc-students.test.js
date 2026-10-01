import { describe, expect, it, vi } from 'vitest';
import { CHANNELS, INVOKE_CHANNELS, createLabIpcHandlers, registerLabIpc } from '../ipc.js';

// Os canais do renderer para alunos, reserva e pasta (GOALS 18): validam a forma do
// que a tela manda e repassam ao gerente só os campos da lista.

function setup() {
  const manager = {
    students: vi.fn(async () => ({ ok: true, students: [] })),
    addStudent: vi.fn(async () => ({ ok: true })),
    setQuota: vi.fn(async () => ({ ok: true })),
    deleteStudent: vi.fn(async () => ({ ok: true })),
    reserve: vi.fn(async () => ({ ok: true })),
    handOver: vi.fn(async () => ({ ok: true })),
    extend: vi.fn(async () => ({ ok: true })),
    end: vi.fn(async () => ({ ok: true })),
    openFolder: vi.fn(async () => ({ ok: true })),
    snapshot: () => [],
  };
  const handlers = createLabIpcHandlers({
    manager,
    store: { getLab: () => ({ mode: true, managed: false, managers: [] }) },
    startWithWindows: {},
    serviceControl: {},
  });
  return { manager, handlers };
}

describe('lab ipc (GOALS 18): channels', () => {
  it('registers every new channel as an invoke handler', () => {
    const { handlers } = setup();
    const ipcMain = { handle: vi.fn() };
    registerLabIpc({ ipcMain, handlers });
    for (const name of [
      'students',
      'studentAdd',
      'studentQuota',
      'studentDelete',
      'reserve',
      'handOver',
      'extend',
      'end',
      'folder',
    ]) {
      expect(INVOKE_CHANNELS).toContain(CHANNELS[name]);
      expect(typeof handlers[CHANNELS[name]]).toBe('function');
      expect(ipcMain.handle).toHaveBeenCalledWith(CHANNELS[name], expect.any(Function));
    }
  });
});

describe('lab ipc (GOALS 18): forwarding', () => {
  it('passes only the known fields to the manager', async () => {
    const { manager, handlers } = setup();
    await handlers[CHANNELS.reserve]({
      hostId: 'h1',
      account: 'ana',
      startWithinMs: 1_800_000,
      sessionMs: 3_600_000,
      password: 'x',
      __proto__: { evil: true },
      extra: 'y',
    });
    expect(manager.reserve).toHaveBeenCalledWith('h1', {
      account: 'ana',
      startWithinMs: 1_800_000,
      sessionMs: 3_600_000,
    });

    await handlers[CHANNELS.handOver]({
      hostId: 'h1',
      account: 'joao',
      startWithinMs: 1_800_000,
      sessionMs: 3_600_000,
    });
    expect(manager.handOver).toHaveBeenCalledWith('h1', {
      account: 'joao',
      startWithinMs: 1_800_000,
      sessionMs: 3_600_000,
    });

    await handlers[CHANNELS.studentAdd]({ hostId: 'h1', label: 'Bia', quotaGb: 20, x: 1 });
    expect(manager.addStudent).toHaveBeenCalledWith('h1', { label: 'Bia', quotaGb: 20 });

    await handlers[CHANNELS.studentQuota]({ hostId: 'h1', account: 'ana', quotaGb: 30 });
    expect(manager.setQuota).toHaveBeenCalledWith('h1', { account: 'ana', quotaGb: 30 });

    await handlers[CHANNELS.studentDelete]({ hostId: 'h1', account: 'ana' });
    expect(manager.deleteStudent).toHaveBeenCalledWith('h1', 'ana');

    await handlers[CHANNELS.extend]({
      hostId: 'h1',
      reservationId: 'abcd1234abcd1234',
      addMs: 600_000,
    });
    expect(manager.extend).toHaveBeenCalledWith('h1', {
      reservationId: 'abcd1234abcd1234',
      addMs: 600_000,
    });

    // "Encerrar agora" não deixa a tela escolher o motivo.
    await handlers[CHANNELS.end]({
      hostId: 'h1',
      reservationId: 'abcd1234abcd1234',
      reason: 'manager-handover',
    });
    expect(manager.end).toHaveBeenCalledWith('h1', { reservationId: 'abcd1234abcd1234' });

    await handlers[CHANNELS.folder]({ hostId: 'h1', account: 'ana' });
    expect(manager.openFolder).toHaveBeenCalledWith('h1', 'ana');

    await handlers[CHANNELS.students]('h1');
    expect(manager.students).toHaveBeenCalledWith('h1');
  });

  it.each([
    ['students', undefined],
    ['students', 5],
    ['students', ''],
    ['studentAdd', null],
    ['studentAdd', 'h1'],
    ['studentQuota', { hostId: 'h1', account: '../x', quotaGb: 20 }],
    ['studentDelete', { hostId: 'h1', account: 'ANA' }],
    ['studentDelete', { account: 'ana' }],
    ['reserve', { hostId: 'h1', account: 'a b' }],
    ['reserve', [1, 2]],
    ['handOver', { hostId: 5, account: 'ana' }],
    ['extend', { hostId: 'h1', reservationId: '' }],
    ['end', { hostId: 'h1' }],
    ['folder', { hostId: 'h1', account: 'x'.repeat(21) }],
  ])('refuses a malformed %s request (%j) without calling the manager', async (name, payload) => {
    const { manager, handlers } = setup();
    expect(await handlers[CHANNELS[name]](payload)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    for (const fn of Object.values(manager)) {
      if (typeof fn.mock?.calls?.length === 'number') expect(fn).not.toHaveBeenCalled();
    }
  });
});
