import { describe, expect, it, vi } from 'vitest';
import { CHANNELS, createLabIpcHandlers } from '../ipc.js';

function handlers(serviceControl) {
  return createLabIpcHandlers({
    manager: { snapshot: () => [], enroll: vi.fn(), remove: vi.fn() },
    store: {
      getLab: () => ({ mode: false, managed: false, managers: [] }),
      removeManager: vi.fn(),
    },
    startWithWindows: { get: vi.fn(), set: vi.fn() },
    serviceControl,
  });
}

const control = (overrides = {}) => ({
  getState: vi.fn(async () => ({ installed: true, running: true })),
  enable: vi.fn(async () => ({ ok: true })),
  disable: vi.fn(async () => ({ ok: true })),
  ...overrides,
});

describe('lab service IPC (enable / disable lab mode)', () => {
  it('reads the service state', async () => {
    const service = control();
    expect(await handlers(service)[CHANNELS.serviceState]()).toEqual({
      installed: true,
      running: true,
    });
  });

  it('enables with the on-site option only when it is exactly true', async () => {
    const service = control();
    const h = handlers(service);
    await h[CHANNELS.enableService]({ studentsOnSite: true });
    await h[CHANNELS.enableService]({});
    await h[CHANNELS.enableService]();
    await h[CHANNELS.enableService](null);
    expect(service.enable.mock.calls.map(([options]) => options)).toEqual([
      { studentsOnSite: true },
      { studentsOnSite: false },
      { studentsOnSite: false },
      { studentsOnSite: false },
    ]);
  });

  it.each([['yes'], [5], [{ studentsOnSite: 'sim' }], [{ studentsOnSite: 1 }]])(
    'rejects an enable request with %j',
    async (payload) => {
      const service = control();
      expect(await handlers(service)[CHANNELS.enableService](payload)).toMatchObject({
        ok: false,
        error: 'bad-request',
      });
      expect(service.enable).not.toHaveBeenCalled();
    },
  );

  it('runs one change at a time, since each opens an administrator prompt', async () => {
    let release;
    const service = control({
      enable: vi.fn(() => new Promise((resolve) => (release = resolve))),
    });
    const h = handlers(service);
    const first = h[CHANNELS.enableService]({});
    expect(await h[CHANNELS.disableService]()).toMatchObject({
      ok: false,
      error: 'busy',
    });
    expect(await h[CHANNELS.enableService]({})).toMatchObject({
      ok: false,
      error: 'busy',
    });
    release({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await h[CHANNELS.disableService]()).toEqual({ ok: true });
  });

  it('frees the lock even if the operation throws', async () => {
    const service = control({
      enable: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const h = handlers(service);
    await expect(h[CHANNELS.enableService]({})).rejects.toThrow('boom');
    expect(await h[CHANNELS.disableService]()).toEqual({ ok: true });
  });
});
