import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sidecarExe = path.join(root, 'sidecar', 'bin', 'Debug', 'OpenPortalRdpSidecar.exe');
const canRun = process.platform === 'win32' && existsSync(sidecarExe);

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
