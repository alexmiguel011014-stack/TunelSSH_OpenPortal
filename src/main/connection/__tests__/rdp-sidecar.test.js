import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sidecarModule from '../rdp-sidecar.js';

const { createRdpSidecarManager } = sidecarModule;

class FakeProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

class FakeSocket extends EventEmitter {
  constructor(autoReady = true) {
    super();
    this.autoReady = autoReady;
    this.writes = [];
    this.ended = false;
    this.writeError = null;
  }

  write(value, callback) {
    if (this.writeError) throw this.writeError;
    this.writes.push(value);
    callback?.();
    return true;
  }

  end() {
    this.ended = true;
  }

  on(eventName, listener) {
    super.on(eventName, listener);
    if (eventName === 'data' && this.autoReady) {
      queueMicrotask(() =>
        this.emit(
          'data',
          Buffer.from(
            '{"type":"status","state":"ready","stage":"control-ready","eventName":"ControlReady"}\n',
          ),
        ),
      );
    }
    return this;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function startOptions(lifecycleId) {
  return { parentHwnd: '1', x: 0, y: 0, w: 800, h: 600, lifecycleId };
}

afterEach(() => vi.useRealTimers());

describe('RDP sidecar lifecycle ownership', () => {
  it('does not switch host mode when the local pipe cannot be opened', async () => {
    let spawned = 0;
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => {
        spawned += 1;
        return new FakeProcess(40);
      },
      connectPipe: async () => null,
      randomUUID: () => 'pipe',
    });

    expect(
      await manager.startRdpSidecar(
        'pc-1',
        { ...startOptions('current'), mode: 'auto-fallback' },
        (status) => statuses.push(status),
      ),
    ).toBe(false);
    expect(spawned).toBe(1);
    expect(statuses.at(-1)).toMatchObject({
      category: 'local-sidecar',
      eventName: 'PipeConnectFailed',
    });
  });

  it('does not switch host mode when the control never acknowledges readiness', async () => {
    vi.useFakeTimers();
    let spawned = 0;
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => {
        spawned += 1;
        return new FakeProcess(41);
      },
      connectPipe: async () => new FakeSocket(false),
      randomUUID: () => 'pipe',
      controlReadyTimeoutMs: 100,
    });

    const starting = manager.startRdpSidecar(
      'pc-1',
      { ...startOptions('current'), mode: 'auto-fallback' },
      (status) => statuses.push(status),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await starting).toBe(false);
    expect(spawned).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ eventName: 'ControlReadyTimeout' });
  });

  it('logs only parsed status fields, never an unexpected credential field', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const socket = new FakeSocket();
      const manager = createRdpSidecarManager({
        spawnProcess: () => new FakeProcess(42),
        connectPipe: async () => socket,
        randomUUID: () => 'pipe',
      });
      await manager.startRdpSidecar('pc-1', startOptions('current'));
      socket.emit(
        'data',
        Buffer.from(
          '{"type":"status","state":"connecting","eventName":"CommandReceived","password":"sentinel-not-for-logs"}\n',
        ),
      );

      expect(logs.mock.calls.flat().join('\n')).not.toContain('sentinel-not-for-logs');
    } finally {
      logs.mockRestore();
    }
  });

  it('keeps the replacement generation after stale completion, cleanup, and old exit', async () => {
    const oldPipe = deferred();
    const newPipe = deferred();
    const oldProcess = new FakeProcess(1);
    const newProcess = new FakeProcess(2);
    const processes = [oldProcess, newProcess];
    const pipes = [oldPipe.promise, newPipe.promise];
    const manager = createRdpSidecarManager({
      spawnProcess: () => processes.shift(),
      connectPipe: () => pipes.shift(),
      randomUUID: () => 'pipe',
    });

    const oldStart = manager.startRdpSidecar('pc-1', startOptions('old'));
    const newStart = manager.startRdpSidecar('pc-1', startOptions('new'));
    const oldSocket = new FakeSocket();
    oldPipe.resolve(oldSocket);
    expect(await oldStart).toBeNull();

    const newSocket = new FakeSocket();
    newPipe.resolve(newSocket);
    expect(await newStart).toBe(true);
    expect(manager.stopRdpSidecar('pc-1', 'old', 'stale-cleanup')).toBe(false);
    oldProcess.emit('exit', null, 'SIGTERM');

    expect(oldProcess.killed).toBe(true);
    expect(newProcess.killed).toBe(false);
    expect(oldSocket.ended).toBe(true);
    expect(manager.isRdpSidecarRunning('pc-1')).toBe(true);
  });

  it('emits one local error for pipe error plus close', async () => {
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(3),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );

    const error = new Error('broken');
    error.code = 'EPIPE';
    socket.emit('error', error);
    socket.emit('close', true);

    expect(statuses).toEqual([
      expect.objectContaining({
        state: 'error',
        category: 'local-sidecar',
        eventName: 'PipeError',
      }),
    ]);
  });

  it('reports a failed command write once', async () => {
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(4),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    const error = new Error('write failed');
    error.code = 'EPIPE';
    socket.writeError = error;

    expect(manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current')).toBe(false);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ state: 'error', eventName: 'CommandWriteFailed' });
  });

  it('does not report planned stop events as failures', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const process = new FakeProcess(5);
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => process,
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );

    expect(manager.stopRdpSidecar('pc-1', 'current', 'renderer-cleanup')).toBe(true);
    expect(socket.ended).toBe(false);
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"disconnected","eventName":"DisconnectComplete"}\n'),
    );
    socket.emit('end');
    socket.emit('close', false);
    process.emit('exit', 0, null);

    expect(statuses).toEqual([]);
    expect(manager.isRdpSidecarRunning('pc-1')).toBe(false);
    expect(socket.writes).toContain('{"cmd":"disconnect","lifecycleId":"current"}\n');
  });

  it('reports an unexpected active process exit once', async () => {
    const process = new FakeProcess(51);
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => process,
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );

    process.emit('exit', 1, null);

    expect(statuses).toEqual([
      expect.objectContaining({ state: 'error', eventName: 'ProcessExit', reasonCode: 1 }),
    ]);
    expect(manager.isRdpSidecarRunning('pc-1')).toBe(false);
  });

  it('keeps two machine generations independent and makes stop idempotent', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(52 + sockets.length),
      connectPipe: async () => sockets.shift(),
      randomUUID: () => 'pipe',
    });
    const firstSocket = sockets[0];
    const secondSocket = sockets[1];
    await manager.startRdpSidecar('pc-1', startOptions('first'));
    await manager.startRdpSidecar('pc-2', startOptions('second'));

    expect(manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'first')).toBe(true);
    expect(manager.sendRdpCommand('pc-2', { cmd: 'connect' }, 'second')).toBe(true);
    expect(firstSocket.writes.at(-1)).toContain('"lifecycleId":"first"');
    expect(secondSocket.writes.at(-1)).toContain('"lifecycleId":"second"');
    expect(manager.stopRdpSidecar('pc-1', 'first')).toBe(true);
    expect(manager.stopRdpSidecar('pc-1', 'first')).toBe(false);
    expect(firstSocket.writes.filter((line) => line.includes('"cmd":"disconnect"'))).toHaveLength(
      1,
    );
    expect(manager.isRdpSidecarRunning('pc-2')).toBe(true);
  });
});

describe('RDP handshake watchdog and terminal states', () => {
  it('reports command dispatch timeout before any ActiveX deadline starts', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(6),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
      commandDispatchTimeoutMs: 100,
      firstEventTimeoutMs: 50,
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current');

    vi.advanceTimersByTime(50);
    expect(statuses.map(({ state }) => state)).toEqual(['connecting']);
    vi.advanceTimersByTime(50);

    expect(statuses.map(({ state }) => state)).toEqual(['connecting', 'error']);
    expect(statuses[1]).toMatchObject({
      category: 'local-sidecar',
      eventName: 'CommandDispatchTimeout',
    });
    expect(socket.writes.at(-1)).toBe('{"cmd":"disconnect","lifecycleId":"current"}\n');
  });

  it('starts the first-event deadline only after ConnectReturned', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(61),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
      commandDispatchTimeoutMs: 200,
      connectCallTimeoutMs: 200,
      firstEventTimeoutMs: 100,
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current');
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"CommandReceived"}\n'),
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(statuses.some(({ state }) => state === 'error')).toBe(false);
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"ConnectReturned"}\n'),
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(statuses.at(-1)).toMatchObject({ category: 'timeout', eventName: 'FirstEventTimeout' });
  });

  it('distinguishes a blocked Connect call from a missing ActiveX event', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(62),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
      connectCallTimeoutMs: 100,
      firstEventTimeoutMs: 50,
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current');
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"CommandReceived"}\n'),
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(statuses.at(-1)).toMatchObject({ category: 'timeout', eventName: 'ConnectCallTimeout' });
  });

  it('cancels the watchdog on authenticated login and deduplicates a later failure', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(7),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
      firstEventTimeoutMs: 100,
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current');
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"CommandReceived"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"ConnectReturned"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connected","eventName":"OnLoginComplete"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"error","eventName":"OnLogonError","reasonCode":1}\n'),
    );
    socket.emit(
      'data',
      Buffer.from(
        '{"type":"status","state":"disconnected","eventName":"OnDisconnected","reasonCode":2}\n',
      ),
    );
    vi.advanceTimersByTime(100);

    expect(statuses.map(({ eventName }) => eventName)).toEqual([
      'CommandSent',
      'CommandReceived',
      'ConnectReturned',
      'OnLoginComplete',
      'OnLogonError',
    ]);
    expect(statuses.at(-1)).toMatchObject({ category: 'authentication', reasonCode: 1 });
  });

  it('moves from the first-event deadline to the authentication deadline', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(8),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
      firstEventTimeoutMs: 100,
      authenticationTimeoutMs: 200,
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current');
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"CommandReceived"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"ConnectReturned"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"OnConnecting"}\n'),
    );

    await vi.advanceTimersByTimeAsync(199);
    expect(statuses.some(({ state }) => state === 'error')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      category: 'timeout',
      eventName: 'AuthenticationTimeout',
    });
  });

  it('does not arm a first-event timer when OnConnecting precedes ConnectReturned', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(81),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
      firstEventTimeoutMs: 50,
      authenticationTimeoutMs: 200,
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current');
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"CommandReceived"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"OnConnecting"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"ConnectReturned"}\n'),
    );
    await vi.advanceTimersByTimeAsync(50);

    expect(statuses.some(({ eventName }) => eventName === 'FirstEventTimeout')).toBe(false);
  });

  it('pauses authentication timeout while a security warning needs user action', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const statuses = [];
    const manager = createRdpSidecarManager({
      spawnProcess: () => new FakeProcess(9),
      connectPipe: async () => socket,
      randomUUID: () => 'pipe',
      firstEventTimeoutMs: 100,
      authenticationTimeoutMs: 100,
    });
    await manager.startRdpSidecar('pc-1', startOptions('current'), (status) =>
      statuses.push(status),
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect' }, 'current');
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"CommandReceived"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"ConnectReturned"}\n'),
    );
    socket.emit(
      'data',
      Buffer.from(
        '{"type":"status","state":"warning","eventName":"OnAuthenticationWarningDisplayed","category":"certificate-warning"}\n',
      ),
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(statuses.some(({ state }) => state === 'error')).toBe(false);
    socket.emit(
      'data',
      Buffer.from(
        '{"type":"status","state":"connecting","eventName":"OnAuthenticationWarningDismissed"}\n',
      ),
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(statuses.at(-1)).toMatchObject({ eventName: 'AuthenticationTimeout' });
  });

  it('falls back once from embedded mode to a native window', async () => {
    vi.useFakeTimers();
    const firstSocket = new FakeSocket();
    const sockets = [firstSocket, new FakeSocket()];
    const spawnedArgs = [];
    const manager = createRdpSidecarManager({
      spawnProcess: (_exe, args) => {
        spawnedArgs.push(args);
        return new FakeProcess(10 + spawnedArgs.length);
      },
      connectPipe: async () => sockets.shift(),
      randomUUID: () => `pipe-${spawnedArgs.length}`,
      firstEventTimeoutMs: 100,
    });
    await manager.startRdpSidecar(
      'pc-1',
      { ...startOptions('current'), mode: 'auto-fallback' },
      () => {},
    );
    manager.sendRdpCommand('pc-1', { cmd: 'connect', host: 'safe-host' }, 'current');
    firstSocket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"CommandReceived"}\n'),
    );
    firstSocket.emit(
      'data',
      Buffer.from('{"type":"status","state":"connecting","eventName":"ConnectReturned"}\n'),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(spawnedArgs).toHaveLength(2);
    expect(spawnedArgs[0][6]).toBe('embedded');
    expect(spawnedArgs[1][6]).toBe('native-window');
    expect(manager.isRdpSidecarRunning('pc-1')).toBe(true);
  });
});
