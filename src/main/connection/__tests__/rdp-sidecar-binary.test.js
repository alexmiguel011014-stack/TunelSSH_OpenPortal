import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sidecarExe = path.join(root, 'sidecar', 'bin', 'Debug', 'OpenPortalRdpSidecar.exe');
const canRun = process.platform === 'win32' && existsSync(sidecarExe);

// Um .exe mais velho que o Program.cs roda o protocolo antigo e faz os
// testes abaixo falharem sem dizer por quê (aconteceu no PC B em 2026-09-29).
describe.skipIf(!canRun)('RDP sidecar binary freshness', () => {
  it('was built after the last change to Program.cs', () => {
    const built = statSync(sidecarExe).mtimeMs;
    const source = statSync(path.join(root, 'sidecar', 'Program.cs')).mtimeMs;
    expect(
      built >= source,
      'sidecar/bin/Debug está desatualizado: recompile com MSBuild (ver docs/ARQUITETURA_CONEXAO.md)',
    ).toBe(true);
  });
});

function connectWithRetry(pipePath, deadline = Date.now() + 5_000) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection(pipePath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', (error) => {
        socket.destroy();
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function statusLines(socket) {
  let pending = '';
  const messages = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const status = JSON.parse(line);
      messages.push(status);
      const waiter = waiters.find(({ predicate }) => predicate(status));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(status);
      }
    }
  });
  const waitFor = (predicate, timeoutMs = 1_000) =>
    new Promise((resolve, reject) => {
      const existing = messages.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      const waiter = { predicate, resolve, timer: null };
      waiters.push(waiter);
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for sidecar status'));
      }, timeoutMs).unref();
    });
  return { messages, waitFor };
}

function waitForExit(child, timeoutMs = 2_000) {
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Sidecar did not exit in time')), timeoutMs).unref(),
    ),
  ]);
}

// G7-R4: o mesmo probe contra os três transportes que o modo ipc-test
// aceita. O stderr traz marcadores de início/fim de cada operação do pipe,
// o que diz qual thread ficou esperando em qual operação.
function traceLines(stream) {
  const lines = [];
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    const parts = pending.split(/\r?\n/);
    pending = parts.pop();
    lines.push(...parts.filter(Boolean));
  });
  return lines;
}

function pendingOperations(trace) {
  const open = new Map();
  for (const line of trace) {
    const match = /^\[ipc\] thread=(\w+) (\S+)-(begin|end|failed)\b/.exec(line);
    if (!match) continue;
    const [, thread, operation, phase] = match;
    const key = `${thread}:${operation}`;
    open.set(key, (open.get(key) || 0) + (phase === 'begin' ? 1 : -1));
  }
  return [...open].filter(([, count]) => count > 0).map(([key]) => key);
}

function cpuMilliseconds(pid) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `[int](Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`,
      ],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? null : Math.round(Number(stdout.trim()))),
    );
  });
}

async function measureTransport(transport) {
  const pipeName = `OpenPortalRdpSidecar-test-${randomUUID()}`;
  const lifecycleId = `test-${randomUUID()}`;
  const child = spawn(sidecarExe, [
    pipeName,
    '0',
    '0',
    '0',
    '320',
    '200',
    'ipc-test',
    lifecycleId,
    String(process.pid),
    transport,
  ]);
  const trace = traceLines(child.stderr);
  const split = transport === 'split';
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const statusSocket = await connectWithRetry(split ? `${pipePath}-status` : pipePath);
  const commandSocket = split ? await connectWithRetry(`${pipePath}-cmd`) : statusSocket;
  const statuses = statusLines(statusSocket);
  const send = (command) => commandSocket.write(`${JSON.stringify({ ...command, lifecycleId })}\n`);
  const isProbe = (sequence) => (status) =>
    status.eventName === 'ProbeReceived' && status.sequence === sequence;
  const result = { transport };

  try {
    await statuses.waitFor((status) => status.eventName === 'ControlReady', 5_000);

    // Um único probe, sem nenhuma outra escrita do cliente enquanto espera.
    const probeSent = performance.now();
    send({ cmd: 'probe', sequence: 1 });
    result.probeMs = await statuses
      .waitFor(isProbe(1), 500)
      .then(() => Math.round(performance.now() - probeSent))
      .catch(() => null);
    result.pendingAtDeadline = pendingOperations(trace);

    if (result.probeMs !== null) {
      const before = statuses.messages.length;
      const burstSent = performance.now();
      send({ cmd: 'probe-burst', count: 100 });
      await statuses.waitFor(
        (status) => isProbe(100)(status) && statuses.messages.indexOf(status) >= before,
        2_000,
      );
      result.burstMs = Math.round(performance.now() - burstSent);
      result.ordered =
        JSON.stringify(
          statuses.messages
            .slice(before)
            .filter(({ eventName }) => eventName === 'ProbeReceived')
            .map(({ sequence }) => sequence),
        ) === JSON.stringify(Array.from({ length: 100 }, (_, index) => index + 1));
    }
    if (process.env.RDP_IPC_REPORT) result.cpuMs = await cpuMilliseconds(child.pid);

    // Parada: pede disconnect, espera a confirmação e fecha o canal.
    const probeBeforeNextWrite = statuses.messages.some(isProbe(1));
    const stopSent = performance.now();
    send({ cmd: 'disconnect' });
    if (!probeBeforeNextWrite) {
      result.probeOnlyAfterNextWriteMs = await statuses
        .waitFor(isProbe(1), 2_000)
        .then(() => Math.round(performance.now() - probeSent))
        .catch(() => null);
    }
    result.disconnectAck = await statuses
      .waitFor((status) => status.eventName === 'DisconnectComplete', 2_000)
      .then(() => true)
      .catch(() => false);
    const exited = waitForExit(child, 2_000);
    commandSocket.end();
    if (split) statusSocket.end();
    const exit = await exited.catch(() => null);
    result.stopMs = exit ? Math.round(performance.now() - stopSent) : null;
    result.exitCode = exit ? exit.code : null;
    result.killed = !exit;
    return result;
  } finally {
    statusSocket.destroy();
    commandSocket.destroy();
    if (child.exitCode === null) child.kill();
  }
}

describe.skipIf(!canRun)('RDP sidecar IPC transport comparison (G7-R4)', () => {
  const results = [];

  afterAll(() => {
    if (process.env.RDP_IPC_REPORT) console.info(JSON.stringify(results, null, 2));
  });

  it('reproduces the stall on the synchronous duplex pipe', async () => {
    const result = await measureTransport('sync-duplex');
    results.push(result);
    expect(result.probeMs).toBeNull();
    expect(result.pendingAtDeadline).toEqual(
      expect.arrayContaining(['ui:status-write', 'worker:command-read']),
    );
    expect(result.probeOnlyAfterNextWriteMs).not.toBeNull();
  }, 20_000);

  it.each(['async-duplex', 'split'])(
    'keeps independent progress and a bounded stop on %s',
    async (transport) => {
      const result = await measureTransport(transport);
      results.push(result);
      expect(result.probeMs).not.toBeNull();
      expect(result.probeMs).toBeLessThanOrEqual(500);
      expect(result.pendingAtDeadline).not.toContain('ui:status-write');
      expect(result.ordered).toBe(true);
      expect(result.disconnectAck).toBe(true);
      expect(result).toMatchObject({ exitCode: 0, killed: false });
      expect(result.stopMs).toBeLessThanOrEqual(2_000);
    },
    20_000,
  );
});

describe.skipIf(!canRun)('RDP sidecar binary IPC', () => {
  it('keeps ordered duplex progress and exits after the disconnect handshake', async () => {
    const pipeName = `OpenPortalRdpSidecar-test-${randomUUID()}`;
    const lifecycleId = `test-${randomUUID()}`;
    const child = spawn(sidecarExe, [
      pipeName,
      '0',
      '0',
      '0',
      '320',
      '200',
      'ipc-test',
      lifecycleId,
      String(process.pid),
    ]);
    const socket = await connectWithRetry(`\\\\.\\pipe\\${pipeName}`);
    const statuses = statusLines(socket);

    try {
      await statuses.waitFor((status) => status.eventName === 'ControlReady');
      socket.write(
        `${JSON.stringify({ cmd: 'probe', sequence: -1, lifecycleId: 'stale-generation' })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(statuses.messages.some(({ sequence }) => sequence === -1)).toBe(false);

      socket.write(
        `${JSON.stringify({ cmd: 'resize', x: 1, y: 2, w: 640, h: 480, lifecycleId })}\n`,
      );
      const fragmentedReply = statuses.waitFor(
        (status) => status.eventName === 'ProbeReceived' && status.sequence === 0,
        500,
      );
      const fragmented = `${JSON.stringify({ cmd: 'probe', sequence: 0, lifecycleId })}\n`;
      socket.write(fragmented.slice(0, 7));
      socket.write(fragmented.slice(7));
      await expect(fragmentedReply).resolves.toMatchObject({ lifecycleId, sequence: 0 });

      const replies = Array.from({ length: 100 }, (_, index) =>
        statuses.waitFor(
          (status) => status.eventName === 'ProbeReceived' && status.sequence === index + 1,
        ),
      );
      socket.write(`${JSON.stringify({ cmd: 'probe-burst', count: 100, lifecycleId })}\n`);
      await expect(Promise.all(replies)).resolves.toHaveLength(100);
      expect(
        statuses.messages
          .filter((status) => status.eventName === 'ProbeReceived' && status.sequence > 0)
          .map(({ sequence }) => sequence),
      ).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));

      const disconnected = statuses.waitFor((status) => status.eventName === 'DisconnectComplete');
      socket.write(`${JSON.stringify({ cmd: 'disconnect', lifecycleId })}\n`);
      await expect(disconnected).resolves.toMatchObject({ state: 'disconnected' });
      const exited = waitForExit(child);
      socket.end();
      await expect(exited).resolves.toMatchObject({ code: 0 });
    } finally {
      socket.destroy();
      if (child.exitCode === null) child.kill();
    }
  });

  it('exits when the IPC peer disappears abruptly', async () => {
    const pipeName = `OpenPortalRdpSidecar-test-${randomUUID()}`;
    const lifecycleId = `test-${randomUUID()}`;
    const child = spawn(sidecarExe, [
      pipeName,
      '0',
      '0',
      '0',
      '320',
      '200',
      'ipc-test',
      lifecycleId,
      String(process.pid),
    ]);
    const socket = await connectWithRetry(`\\\\.\\pipe\\${pipeName}`);
    const statuses = statusLines(socket);

    try {
      await statuses.waitFor((status) => status.eventName === 'ControlReady');
      const exited = waitForExit(child);
      socket.destroy();
      await expect(exited).resolves.toMatchObject({ code: 0 });
    } finally {
      socket.destroy();
      if (child.exitCode === null) child.kill();
    }
  });

  it('exits instead of blocking when the bounded status queue saturates', async () => {
    const pipeName = `OpenPortalRdpSidecar-test-${randomUUID()}`;
    const lifecycleId = `test-${randomUUID()}`;
    const child = spawn(sidecarExe, [
      pipeName,
      '0',
      '0',
      '0',
      '320',
      '200',
      'ipc-test',
      lifecycleId,
      String(process.pid),
    ]);
    const socket = await connectWithRetry(`\\\\.\\pipe\\${pipeName}`);
    const statuses = statusLines(socket);

    try {
      await statuses.waitFor((status) => status.eventName === 'ControlReady');
      socket.pause();
      const exited = waitForExit(child, 3_000);
      socket.write(`${JSON.stringify({ cmd: 'probe-burst', count: 5000, lifecycleId })}\n`);
      await expect(exited).resolves.toMatchObject({ code: 0 });
    } finally {
      socket.destroy();
      if (child.exitCode === null) child.kill();
    }
  });
});

// G6-R1/C1/C3: o ActiveX MSTSCLib de verdade, sem destino RDP nem credencial
// real. O alvo é um TCP local que aceita e fecha, então o controle passa por
// Connect(), OnConnecting e OnDisconnected em menos de um segundo. Roda nos
// dois modos: janela própria e embutido numa janela de outro processo
// (SetParent entre processos, como no Electron).
function startClosingTarget() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startParentWindow() {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'openportal-test-parent'; $f.Show(); [Console]::Out.WriteLine($f.Handle.ToInt64()); [Console]::Out.Flush(); [Windows.Forms.Application]::Run($f)",
    ]);
    ps.stdout.once('data', (data) => resolve({ hwnd: data.toString().trim(), process: ps }));
    ps.once('error', reject);
  });
}

describe.skipIf(!canRun)('RDP sidecar with the real ActiveX control', () => {
  it.each(['native-window', 'embedded'])(
    'delivers the native events promptly in %s mode',
    async (hostMode) => {
      const target = await startClosingTarget();
      const parent = hostMode === 'embedded' ? await startParentWindow() : null;
      const pipeName = `OpenPortalRdpSidecar-test-${randomUUID()}`;
      const lifecycleId = `test-${randomUUID()}`;
      const child = spawn(sidecarExe, [
        pipeName,
        parent ? parent.hwnd : '0',
        '0',
        '0',
        '640',
        '480',
        hostMode,
        lifecycleId,
        String(process.pid),
      ]);
      const socket = await connectWithRetry(`\\\\.\\pipe\\${pipeName}`);
      const statuses = statusLines(socket);

      try {
        const ready = await statuses.waitFor((status) => status.state === 'ready', 10_000);
        if (hostMode === 'embedded') {
          expect(ready).toMatchObject({ eventName: 'EmbeddingResult', setParentError: 0 });
        }
        const disconnected = statuses.waitFor(
          (status) => status.eventName === 'OnDisconnected',
          10_000,
        );
        socket.write(
          `${JSON.stringify({
            cmd: 'connect',
            host: '127.0.0.1',
            port: target.address().port,
            username: 'test-user',
            password: 'not-a-secret',
            lifecycleId,
          })}\n`,
        );
        await expect(disconnected).resolves.toMatchObject({ reasonCode: 2308, extendedReason: 7 });
        const order = statuses.messages
          .map(({ eventName }) => eventName)
          .filter((name) =>
            [
              'CommandReceived',
              'ConnectInvoking',
              'ConnectReturned',
              'OnConnecting',
              'OnDisconnected',
            ].includes(name),
          );
        expect(order).toEqual([
          'CommandReceived',
          'ConnectInvoking',
          'ConnectReturned',
          'OnConnecting',
          'OnDisconnected',
        ]);
        expect(statuses.messages.every(({ password, username }) => !password && !username)).toBe(
          true,
        );

        const probe = statuses.waitFor((status) => status.eventName === 'WindowProbe', 2_000);
        socket.write(`${JSON.stringify({ cmd: 'probe-windows', lifecycleId })}\n`);
        await expect(probe).resolves.toMatchObject({ windows: expect.any(Array) });

        const done = statuses.waitFor((status) => status.eventName === 'DisconnectComplete', 2_000);
        socket.write(`${JSON.stringify({ cmd: 'disconnect', lifecycleId })}\n`);
        await done;
        const exited = waitForExit(child, 3_000);
        socket.end();
        await expect(exited).resolves.toMatchObject({ code: 0 });
      } finally {
        socket.destroy();
        if (child.exitCode === null) child.kill();
        parent?.process.kill();
        target.close();
      }
    },
    20_000,
  );
});
