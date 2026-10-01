import { describe, it, expect, vi } from 'vitest';
import { ConnectionRequestServer } from '../../connection/connection-request.js';
import { FailureLimiter } from '../../connection/session-password.js';
import { createLabHost } from '../host.js';
import { createLabManager } from '../manager.js';
import { createLabStore } from '../lab-store.js';
import { sendLabRequest } from '../client.js';

// Dois "PCs" no mesmo processo, falando de verdade pela rede de loopback: o PC
// B (servidor real + host) e o PC A (cliente real + gerente). Só a identidade
// (tailscale whois) e o diálogo do dono do PC B são simulados.
const PROF = 'prof@escola.com';

function memoryStore(initial = {}) {
  let disk = initial;
  return createLabStore({
    read: () => structuredClone(disk),
    write: (next) => {
      disk = structuredClone(next);
    },
    randomUUID: () => 'host-b-uuid',
  });
}

async function startPcB({ answer = 'accepted', port = 0 } = {}) {
  const storeB = memoryStore();
  const askEnrollment = vi.fn(async () => answer);
  const host = createLabHost({
    resolveIdentity: async () => PROF,
    limiter: new FailureLimiter(),
    store: storeB,
    askEnrollment,
    info: { hostName: () => 'PC-B', appVersion: () => '1.0.8' },
  });
  const server = new ConnectionRequestServer(vi.fn(), {
    labHandler: (args) => host.handle(args),
  });
  server.start(port, { retryInUseMs: 0 });
  await new Promise((resolve) => server.server.once('listening', resolve));
  return { server, storeB, askEnrollment, port: server.server.address().port };
}

function startPcA(port) {
  const storeA = memoryStore();
  const onChange = vi.fn();
  const manager = createLabManager({
    store: storeA,
    // O endereço guardado na lista é o do Tailscale; aqui a rede é o loopback.
    sendRequest: (_host, built, opts) => sendLabRequest('127.0.0.1', built, { ...opts, port }),
    isAllowedHost: () => true,
    onChange,
  });
  return { manager, storeA, onChange };
}

describe('lab mode end to end (PC A manager, PC B managed)', () => {
  it('A enrolls B, sees it as free, loses it when B removes the manager, sees it offline when B closes', async () => {
    const pcB = await startPcB();
    const { manager } = startPcA(pcB.port);
    try {
      const enrolled = await manager.enroll('100.64.0.7');
      expect(enrolled).toMatchObject({
        ok: true,
        entry: { hostId: 'host-b-uuid', name: 'PC-B', host: '100.64.0.7' },
      });
      expect(pcB.askEnrollment).toHaveBeenCalledWith(expect.objectContaining({ login: PROF }));
      expect(pcB.storeB.getLab().managers).toEqual([PROF]);

      await manager.pollOnce();
      expect(manager.snapshot()[0]).toMatchObject({
        state: 'free',
        appVersion: '1.0.8',
        studentCount: 0,
        service: { installed: false, running: false },
      });

      // "Remover gerente" no PC B: o próximo status de A é recusado.
      pcB.storeB.removeManager(PROF);
      await manager.pollOnce();
      expect(manager.snapshot()[0].state).toBe('refused');

      // B volta a aceitar A, e depois o app de B fecha.
      pcB.storeB.addManager(PROF);
      await manager.pollOnce();
      expect(manager.snapshot()[0].state).toBe('free');
      pcB.server.stop();
      await manager.pollOnce();
      expect(manager.snapshot()[0].state).toBe('free');
      await manager.pollOnce();
      expect(manager.snapshot()[0].state).toBe('offline');

      // O app de B reabre na mesma porta: A o encontra de novo.
      const reopened = new ConnectionRequestServer(vi.fn(), {
        labHandler: async () => ({
          type: 'lab-response',
          request: 'lab-status',
          ok: true,
          labProtocol: 1,
          hostId: 'host-b-uuid',
          hostName: 'PC-B',
          appVersion: '1.0.8',
          managed: true,
          state: 'free',
          studentCount: 0,
        }),
      });
      reopened.start(pcB.port, { retryInUseMs: 0 });
      await new Promise((resolve) => reopened.server.once('listening', resolve));
      try {
        await manager.pollOnce();
        expect(manager.snapshot()[0].state).toBe('free');
      } finally {
        reopened.stop();
      }
    } finally {
      pcB.server.stop();
    }
  });

  it('A is not enrolled when the person at B clicks Rejeitar', async () => {
    const pcB = await startPcB({ answer: 'rejected' });
    const { manager, storeA } = startPcA(pcB.port);
    try {
      expect(await manager.enroll('100.64.0.7')).toMatchObject({
        ok: false,
        error: 'rejected',
      });
      expect(storeA.getLab().roster).toEqual([]);
      expect(pcB.storeB.getLab().managers).toEqual([]);
    } finally {
      pcB.server.stop();
    }
  });

  it('a PC that is not running OpenPortal is reported as unreachable, not as a crash', async () => {
    const pcB = await startPcB();
    const { port } = pcB;
    pcB.server.stop();
    const { manager } = startPcA(port);
    expect(await manager.enroll('100.64.0.7')).toMatchObject({
      ok: false,
      error: 'unreachable',
    });
  });
});

describe('sendLabRequest', () => {
  it('times out when the PC accepts the connection and never answers', async () => {
    const server = new ConnectionRequestServer(vi.fn(), {
      labHandler: () => new Promise(() => {}),
    });
    server.start(0, { retryInUseMs: 0 });
    await new Promise((resolve) => server.server.once('listening', resolve));
    try {
      const { buildRequest } = await import('../protocol.js');
      const result = await sendLabRequest('127.0.0.1', buildRequest('lab-status'), {
        port: server.server.address().port,
        timeoutMs: 150,
      });
      expect(result).toMatchObject({ ok: false, error: 'timeout' });
    } finally {
      server.stop();
    }
  });

  it('refuses to send a request that failed validation', async () => {
    const { buildRequest } = await import('../protocol.js');
    const result = await sendLabRequest('127.0.0.1', buildRequest('lab-student-add', {}));
    expect(result).toMatchObject({ ok: false, error: 'bad-request' });
  });
});
