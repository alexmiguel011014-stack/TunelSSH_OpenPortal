import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import {
  CHANNELS,
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  createLabIpcHandlers,
  registerLabIpc,
} from '../ipc.js';
import { createLabRuntime } from '../runtime.js';
import { createLabStore } from '../lab-store.js';
import { createStartWithWindows } from '../login-item.js';
import { buildSuccess } from '../protocol.js';

const PROF = 'prof@escola.com';

function memoryStore(initial = {}) {
  let disk = initial;
  return createLabStore({
    read: () => structuredClone(disk),
    write: (next) => {
      disk = structuredClone(next);
    },
    randomUUID: () => 'host-uuid',
  });
}

const entry = (state, extra = {}) => ({
  hostId: 'host-1',
  name: 'PC 1',
  host: '100.64.0.1',
  state,
  ...extra,
});

function handlersFor({ snapshot = [], store = memoryStore(), startWithWindows } = {}) {
  const manager = {
    snapshot: vi.fn(() => snapshot),
    enroll: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(() => ({ ok: true })),
  };
  const onHostChanged = vi.fn();
  const handlers = createLabIpcHandlers({
    manager,
    store,
    startWithWindows: startWithWindows ?? {
      get: () => ({ supported: false, enabled: false }),
      set: vi.fn(),
    },
    onHostChanged,
  });
  return { handlers, manager, store, onHostChanged };
}

describe('lab IPC surface', () => {
  const root = path.resolve(__dirname, '../../..');
  const labChannelsIn = (file) =>
    new Set(
      [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/'(lab:[A-Za-z]+)'/g)].map(
        (m) => m[1],
      ),
    );

  it('lists exactly the documented names', () => {
    expect([...INVOKE_CHANNELS, ...PUSH_CHANNELS].sort()).toEqual(
      [
        'lab:roster',
        'lab:add',
        'lab:remove',
        'lab:status',
        'lab:open',
        'lab:managers',
        'lab:removeManager',
        'lab:hostChanged',
        'lab:getStartWithWindows',
        'lab:setStartWithWindows',
      ].sort(),
    );
    expect(new Set(Object.values(CHANNELS)).size).toBe(Object.values(CHANNELS).length);
  });

  it('preload exposes exactly those channels, no more and no fewer', () => {
    expect(labChannelsIn('main/preload.js')).toEqual(
      new Set([...INVOKE_CHANNELS, ...PUSH_CHANNELS]),
    );
  });

  it('registers a handler for every invoke channel and for nothing else', () => {
    const registered = [];
    const { handlers } = handlersFor();
    registerLabIpc({
      ipcMain: { handle: (channel) => registered.push(channel) },
      handlers,
    });
    expect(registered.sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('the handler receives the payload, not the IPC event', async () => {
    const { handlers, manager } = handlersFor();
    const handle = {};
    registerLabIpc({
      ipcMain: { handle: (channel, fn) => (handle[channel] = fn) },
      handlers,
    });
    await handle[CHANNELS.add]({ sender: 'event' }, '100.64.0.7');
    expect(manager.enroll).toHaveBeenCalledWith('100.64.0.7');
  });
});

describe('lab IPC handlers validate their input', () => {
  it.each([undefined, null, 5, '', {}, [], 'x'.repeat(46)])('add rejects %j', async (payload) => {
    const { handlers, manager } = handlersFor();
    expect(await handlers[CHANNELS.add](payload)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(manager.enroll).not.toHaveBeenCalled();
  });

  it('add accepts a string or { host }', async () => {
    const { handlers, manager } = handlersFor();
    await handlers[CHANNELS.add]('100.64.0.7');
    await handlers[CHANNELS.add]({ host: '100.64.0.8' });
    expect(manager.enroll.mock.calls.map(([host]) => host)).toEqual(['100.64.0.7', '100.64.0.8']);
  });

  it.each([undefined, null, 7, '', {}, 'x'.repeat(65)])('remove and open reject %j', (payload) => {
    const { handlers, manager } = handlersFor();
    expect(handlers[CHANNELS.remove](payload)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(handlers[CHANNELS.open](payload)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'yes', 1, {}])('setStartWithWindows rejects %j', (payload) => {
    const startWithWindows = { get: vi.fn(), set: vi.fn() };
    const { handlers } = handlersFor({ startWithWindows });
    expect(handlers[CHANNELS.setStartWithWindows](payload)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(startWithWindows.set).not.toHaveBeenCalled();
  });

  it('removeManager rejects a non-string login', () => {
    const { handlers } = handlersFor({
      store: memoryStore({ lab: { managers: [PROF] } }),
    });
    expect(handlers[CHANNELS.removeManager](null)).toMatchObject({
      ok: false,
      error: 'bad-request',
    });
    expect(handlers[CHANNELS.removeManager]({ login: PROF })).toMatchObject({
      ok: false,
    });
  });
});

describe('lab:open ("Abrir tela")', () => {
  it.each(['free', 'reserved'])(
    'offers the screen of a %s PC through the normal connect flow',
    (state) => {
      const { handlers } = handlersFor({ snapshot: [entry(state)] });
      expect(handlers[CHANNELS.open]('host-1')).toEqual({
        ok: true,
        machine: {
          id: 'lab-host-1',
          name: 'PC 1',
          host: '100.64.0.1',
          port: 5900,
        },
      });
    },
  );

  it.each(['in-use', 'offline', 'incompatible', 'refused', 'checking'])(
    'does not offer it for a %s PC',
    (state) => {
      const { handlers } = handlersFor({ snapshot: [entry(state)] });
      const result = handlers[CHANNELS.open]('host-1');
      expect(result).toMatchObject({ ok: false, error: state });
      expect(result.message.length).toBeGreaterThan(10);
      expect(result).not.toHaveProperty('machine');
    },
  );

  it('points an in-use PC to "Ver pasta"', () => {
    const { handlers } = handlersFor({ snapshot: [entry('in-use')] });
    expect(handlers[CHANNELS.open]('host-1').message).toContain('Ver pasta');
  });

  it('refuses a PC that is not in the list', () => {
    const { handlers } = handlersFor({ snapshot: [entry('free')] });
    expect(handlers[CHANNELS.open]('other')).toMatchObject({
      ok: false,
      error: 'unknown-pc',
    });
  });
});

describe('lab:managers and "Remover gerente"', () => {
  it('reports who manages this PC', () => {
    const { handlers } = handlersFor({
      store: memoryStore({ lab: { managers: [PROF], mode: false } }),
    });
    expect(handlers[CHANNELS.managers]()).toEqual({
      mode: false,
      managed: true,
      managers: [PROF],
    });
  });

  it('removing the last manager turns managed off and tells the screen', () => {
    const store = memoryStore({ lab: { managers: [PROF] } });
    const { handlers, onHostChanged } = handlersFor({ store });
    expect(handlers[CHANNELS.removeManager](PROF)).toEqual({
      ok: true,
      mode: false,
      managed: false,
      managers: [],
    });
    expect(onHostChanged).toHaveBeenCalledTimes(1);
    expect(handlers[CHANNELS.removeManager](PROF)).toMatchObject({ ok: false });
    expect(onHostChanged).toHaveBeenCalledTimes(1);
  });

  it('never returns hostId, roster or any secret', () => {
    const { handlers } = handlersFor({
      store: memoryStore({
        lab: { managers: [PROF], roster: [] },
        hostVnc: { passwordEnc: 'x' },
      }),
    });
    expect(Object.keys(handlers[CHANNELS.managers]()).sort()).toEqual([
      'managed',
      'managers',
      'mode',
    ]);
  });
});

describe('start with Windows', () => {
  const fakeApp = (open = false) => {
    const state = { openAtLogin: open };
    return {
      state,
      getLoginItemSettings: () => ({ openAtLogin: state.openAtLogin }),
      setLoginItemSettings: vi.fn((settings) => {
        state.openAtLogin = settings.openAtLogin;
      }),
    };
  };

  it('is off by default and turns on and off in the installed app', () => {
    const app = fakeApp();
    const item = createStartWithWindows({
      app,
      isPackaged: true,
      platform: 'win32',
    });
    expect(item.get()).toEqual({ supported: true, enabled: false });
    expect(item.set(true)).toEqual({
      ok: true,
      supported: true,
      enabled: true,
    });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    });
    expect(item.set(false)).toEqual({
      ok: true,
      supported: true,
      enabled: false,
    });
  });

  it('does nothing in development or off Windows', () => {
    for (const options of [
      { isPackaged: false, platform: 'win32' },
      { isPackaged: true, platform: 'linux' },
    ]) {
      const app = fakeApp();
      const item = createStartWithWindows({ app, ...options });
      expect(item.get()).toEqual({ supported: false, enabled: false });
      expect(item.set(true)).toMatchObject({ ok: false, error: 'unsupported' });
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    }
  });

  it('reports failure when Windows does not keep the setting', () => {
    const app = fakeApp();
    app.setLoginItemSettings = vi.fn();
    const item = createStartWithWindows({
      app,
      isPackaged: true,
      platform: 'win32',
    });
    expect(item.set(true)).toMatchObject({
      ok: false,
      error: 'failed',
      enabled: false,
    });
    app.setLoginItemSettings = () => {
      throw new Error('denied');
    };
    expect(item.set(true)).toMatchObject({ ok: false, error: 'failed' });
  });

  it('only a real boolean true turns it on', () => {
    const app = fakeApp();
    const item = createStartWithWindows({
      app,
      isPackaged: true,
      platform: 'win32',
    });
    expect(item.set('yes').enabled).toBe(false);
  });
});

describe('createLabRuntime', () => {
  function build({ managers = [], answer = 0, roster = [], sendRequest } = {}) {
    const lab = { ...(managers.length ? { managers } : {}), ...(roster.length ? { roster } : {}) };
    const store = memoryStore(Object.keys(lab).length ? { lab } : {});
    const invoke = {};
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const runtime = createLabRuntime({
      app: {
        getVersion: () => '1.0.8',
        getLoginItemSettings: () => ({}),
        setLoginItemSettings() {},
      },
      ipcMain: { handle: (channel, fn) => (invoke[channel] = fn) },
      store,
      getMainWindow: () => win,
      resolveIdentity: async () => PROF,
      showDialog: vi.fn(async () => ({ response: answer })),
      isAllowedHost: () => true,
      sendRequest,
      hostName: () => 'PC-B',
      isPackaged: true,
      log: () => {},
    });
    return { runtime, store, invoke, win };
  }

  it('registers the IPC and answers lab-status from a manager', async () => {
    const { runtime, invoke } = build({ managers: [PROF] });
    expect(Object.keys(invoke).sort()).toEqual([...INVOKE_CHANNELS].sort());
    const input = JSON.stringify({ type: 'lab-status', labProtocol: 1 });
    const response = await runtime.labHandler({
      input,
      remoteAddress: '100.64.0.9',
    });
    expect(response).toMatchObject({
      ok: true,
      hostId: 'host-uuid',
      hostName: 'PC-B',
      appVersion: '1.0.8',
      managed: true,
    });
    expect(JSON.stringify(response)).not.toMatch(/pass|token|secret/i);
  });

  it('enrolling a manager tells the home screen', async () => {
    const { runtime, win, store } = build({ answer: 0 });
    const input = JSON.stringify({ type: 'lab-enroll', labProtocol: 1 });
    expect(await runtime.labHandler({ input, remoteAddress: '100.64.0.9' })).toMatchObject({
      accepted: true,
    });
    expect(store.getLab().managers).toEqual([PROF]);
    expect(win.webContents.send).toHaveBeenCalledWith(CHANNELS.hostChanged, {
      mode: false,
      managed: true,
      managers: [PROF],
    });
  });

  it('pushes the roster to the screen when it changes', async () => {
    const empty = build();
    await empty.runtime.manager.pollOnce();
    expect(empty.win.webContents.send).not.toHaveBeenCalled();

    const { runtime, win } = build({
      roster: [{ hostId: 'host-1', name: 'PC 1', host: '100.64.0.1', enrolledAt: 1 }],
      sendRequest: async () => ({
        ok: true,
        response: buildSuccess('lab-status', {
          hostId: 'host-1',
          hostName: 'PC 1',
          state: 'in-use',
          student: { label: 'Ana', since: 1, endsAt: 2 },
        }),
      }),
    });
    await runtime.manager.pollOnce();
    expect(win.webContents.send).toHaveBeenCalledWith(CHANNELS.status, [
      expect.objectContaining({ hostId: 'host-1', state: 'in-use' }),
    ]);
  });
});
