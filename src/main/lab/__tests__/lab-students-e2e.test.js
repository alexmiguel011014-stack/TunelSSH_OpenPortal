import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRequestServer } from '../../connection/connection-request.js';
import { FailureLimiter } from '../../connection/session-password.js';
import * as fileTransferSession from '../../file-transfer/file-transfer-session.js';
import { openLabFolder, sendLabRequest } from '../client.js';
import { createLabHost } from '../host.js';
import { createLabManager } from '../manager.js';
import { createLabStore } from '../lab-store.js';

// PC A (gerente) e PC B (gerenciado) falando de verdade pela rede de loopback, com um
// "serviço do laboratório" de mentira no PC B que segue as mesmas regras do real:
// uma reserva por vez, senha nova a cada reserva, apagar aluno recusado enquanto ele
// está reservado. Cobre o cenário do GOALS 18: reservar, ocupado, trocar aluno,
// pasta somente leitura e apagar.
const PROF = 'prof@escola.com';
const HOST_ID = 'host-b-uuid';

function fakeLabService(profilesRoot) {
  const students = new Map();
  let reservation = null;
  let counter = 0;
  const currentPasswords = new Map();
  const control = { logoffFails: false, ended: [] };

  const view = (student) => ({
    account: student.account,
    label: student.label,
    quotaGb: student.quotaGb,
    state: reservation?.account === student.account ? reservation.state : 'free',
    lastSessionEnd: 0,
  });
  const reservationView = () =>
    reservation && {
      id: reservation.id,
      account: reservation.account,
      label: students.get(reservation.account).label,
      state: reservation.state,
      startBy: reservation.startBy,
      endsAt: reservation.endsAt,
      createdAt: 1,
      firstLogonAt: 0,
    };

  return {
    control,
    currentPasswords,
    hasReservation: () => reservation,
    status: async () => ({
      ok: true,
      state: reservation ? reservation.state : 'free',
      studentCount: students.size,
      quota: 'enforce',
      students: [...students.values()].map((student) => ({ ...view(student), usedBytes: 0 })),
      ...(reservation ? { reservation: reservationView() } : {}),
      disk: { totalGb: 250, freeGb: 120, usedByStudentsGb: 0 },
    }),
    diskInfo: async () => ({
      ok: true,
      totalGb: 250,
      freeGb: 120,
      reserveGb: 50,
      quotaGb: 25,
      recommended: 2,
      assignedGb: students.size * 25,
      usedByStudentsGb: 0,
      status: 'ok',
    }),
    studentCreate: async ({ label, quotaGb }) => {
      const account = label.toLowerCase().replace(/[^a-z0-9]/g, '');
      const student = { account, label, quotaGb };
      students.set(account, student);
      fs.mkdirSync(path.join(profilesRoot, account), { recursive: true });
      return { ok: true, ...view(student) };
    },
    studentSetQuota: async ({ account, quotaGb }) => {
      const student = students.get(account);
      if (!student) return { ok: false, error: 'not-found', message: 'Aluno não encontrado' };
      student.quotaGb = quotaGb;
      return { ok: true, ...view(student) };
    },
    studentDelete: async (account) => {
      if (!students.has(account))
        return { ok: false, error: 'not-found', message: 'Aluno não encontrado' };
      if (reservation?.account === account) {
        return {
          ok: false,
          error: 'busy',
          message: 'Esse aluno está com o PC reservado; encerre a reserva antes',
        };
      }
      students.delete(account);
      fs.rmSync(path.join(profilesRoot, account), { recursive: true, force: true });
      return { ok: true, account };
    },
    reserve: async ({ account, startWithinMs, sessionMs }) => {
      if (!students.has(account))
        return { ok: false, error: 'not-found', message: 'Aluno não encontrado' };
      if (reservation) {
        return {
          ok: false,
          error: 'busy',
          message: 'O PC já está reservado',
          account: reservation.account,
          label: students.get(reservation.account).label,
          state: reservation.state,
          endsAt: reservation.endsAt,
        };
      }
      counter += 1;
      const password = `Pw${String(counter).padStart(14, 'x')}`;
      currentPasswords.set(account, password);
      reservation = {
        id: `reserva-${String(counter).padStart(8, '0')}`,
        account,
        state: 'in-use',
        startBy: 1000 + startWithinMs,
        endsAt: 1000 + startWithinMs + sessionMs,
      };
      return {
        ok: true,
        reservationId: reservation.id,
        account,
        userName: `PC-B\\${account}`,
        password,
        startBy: reservation.startBy,
        endsAt: reservation.endsAt,
      };
    },
    extend: async ({ reservationId, addMs }) => {
      if (!reservation || reservation.id !== reservationId) {
        return { ok: false, error: 'not-found', message: 'Reserva não encontrada' };
      }
      reservation.endsAt += addMs;
      return { ok: true, reservationId, endsAt: reservation.endsAt };
    },
    end: async ({ reservationId, reason }) => {
      if (!reservation || reservation.id !== reservationId) {
        return { ok: false, error: 'not-found', message: 'Reserva não encontrada' };
      }
      if (control.logoffFails) {
        return {
          ok: false,
          error: 'logoff-failed',
          message: 'Não consegui encerrar a sessão do aluno',
        };
      }
      // A senha antiga deixa de valer: a conta fica desabilitada até a próxima reserva.
      currentPasswords.delete(reservation.account);
      control.ended.push({ account: reservation.account, reason });
      reservation = null;
      return { ok: true, ended: true, reason };
    },
    ensureFolderAccess: async (account) => {
      if (!students.has(account))
        return { ok: false, error: 'not-found', message: 'Aluno não encontrado' };
      return { ok: true, account, path: path.join(profilesRoot, account) };
    },
  };
}

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function startLab() {
  const profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'op-lab-users-'));
  cleanup.push(() => fs.rmSync(profilesRoot, { recursive: true, force: true }));
  const service = fakeLabService(profilesRoot);

  let diskB = {};
  const storeB = createLabStore({
    read: () => structuredClone(diskB),
    write: (next) => {
      diskB = structuredClone(next);
    },
    randomUUID: () => HOST_ID,
  });
  const logsB = [];
  const host = createLabHost({
    resolveIdentity: async () => PROF,
    limiter: new FailureLimiter(),
    store: storeB,
    askEnrollment: vi.fn(async () => 'accepted'),
    info: { hostName: () => 'PC-B', appVersion: () => '1.0.8' },
    service,
    usersRoot: profilesRoot,
    log: (line) => logsB.push(line),
  });
  const server = new ConnectionRequestServer(vi.fn(), { labHandler: (args) => host.handle(args) });
  server.start(0, { retryInUseMs: 0 });
  await new Promise((resolve) => server.server.once('listening', resolve));
  cleanup.push(() => server.stop());
  const { port } = server.server.address();

  let diskA = {};
  const storeA = createLabStore({
    read: () => structuredClone(diskA),
    write: (next) => {
      diskA = structuredClone(next);
    },
  });
  const manager = createLabManager({
    store: storeA,
    sendRequest: (_host, built, options) =>
      sendLabRequest('127.0.0.1', built, { ...options, port }),
    openFolder: (_host, built, options) => openLabFolder('127.0.0.1', built, { ...options, port }),
    adoptFileSession: fileTransferSession.adopt,
    isAllowedHost: () => true,
  });
  cleanup.push(() => fileTransferSession.disconnectAll());
  expect((await manager.enroll('100.64.0.7')).ok).toBe(true);
  await manager.pollOnce();
  return { manager, service, logsB, profilesRoot };
}

const when = (account) => ({ account, startWithinMs: 1_800_000, sessionMs: 3_600_000 });

describe('lab students end to end (GOALS 18)', () => {
  it('reserves, refuses a second student, hands over, and the old password stops working', async () => {
    const { manager, service, logsB } = await startLab();
    expect((await manager.addStudent(HOST_ID, { label: 'Ana', quotaGb: 25 })).ok).toBe(true);
    expect((await manager.addStudent(HOST_ID, { label: 'Joao', quotaGb: 25 })).ok).toBe(true);
    const listed = await manager.students(HOST_ID);
    expect(listed.students.map((student) => student.account)).toEqual(['ana', 'joao']);
    expect(listed.capacity).toMatchObject({ recommended: 2, status: 'ok' });

    const ana = await manager.reserve(HOST_ID, when('ana'));
    expect(ana).toMatchObject({ ok: true, credentials: { account: 'ana', userName: 'PC-B\\ana' } });
    const anaPassword = ana.credentials.password;
    expect(service.currentPasswords.get('ana')).toBe(anaPassword);

    // Nunca dois: João é recusado dizendo quem está com o PC.
    expect(await manager.reserve(HOST_ID, when('joao'))).toMatchObject({
      ok: false,
      error: 'busy',
      busyWith: { account: 'ana', label: 'Ana' },
    });
    expect(service.hasReservation().account).toBe('ana');

    // O encerramento falha: a Ana continua com o PC e nada é reservado para o João.
    service.control.logoffFails = true;
    const failed = await manager.handOver(HOST_ID, when('joao'));
    expect(failed).toMatchObject({ ok: false, error: 'logoff-failed', step: 'end' });
    expect(failed.message).toMatch(/Nada foi reservado/);
    expect(service.hasReservation().account).toBe('ana');
    expect(service.currentPasswords.has('joao')).toBe(false);

    // Agora o logoff funciona: a Ana é encerrada e o João recebe uma senha nova.
    service.control.logoffFails = false;
    const swapped = await manager.handOver(HOST_ID, when('joao'));
    expect(swapped).toMatchObject({
      ok: true,
      previous: { account: 'ana', label: 'Ana' },
      credentials: { account: 'joao' },
    });
    expect(service.control.ended).toEqual([{ account: 'ana', reason: 'manager-handover' }]);
    expect(service.currentPasswords.has('ana')).toBe(false);
    expect(service.currentPasswords.get('joao')).toBe(swapped.credentials.password);
    expect(swapped.credentials.password).not.toBe(anaPassword);

    // A senha do aluno nunca entra no registro do PC gerenciado.
    expect(logsB.length).toBeGreaterThan(0);
    for (const line of logsB) {
      expect(line).not.toContain(anaPassword);
      expect(line).not.toContain(swapped.credentials.password);
    }
  });

  it('extends and ends a reservation, and refuses to delete a reserved student', async () => {
    const { manager, service } = await startLab();
    await manager.addStudent(HOST_ID, { label: 'Ana', quotaGb: 25 });
    const reserved = await manager.reserve(HOST_ID, when('ana'));
    const { reservationId } = reserved.credentials;
    const before = service.hasReservation().endsAt;
    expect(await manager.extend(HOST_ID, { reservationId, addMs: 600_000 })).toMatchObject({
      ok: true,
      endsAt: before + 600_000,
    });
    expect(await manager.deleteStudent(HOST_ID, 'ana')).toMatchObject({
      ok: false,
      error: 'busy',
    });
    expect((await manager.end(HOST_ID, { reservationId })).ok).toBe(true);
    expect(service.hasReservation()).toBeNull();
    expect(await manager.deleteStudent(HOST_ID, 'ana')).toEqual({ ok: true, account: 'ana' });
    expect((await manager.students(HOST_ID)).students).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')(
    'opens the student folder read-only: lists and downloads, refuses to change anything',
    async () => {
      const { manager, profilesRoot } = await startLab();
      await manager.addStudent(HOST_ID, { label: 'Ana', quotaGb: 25 });
      fs.writeFileSync(path.join(profilesRoot, 'ana', 'trabalho.txt'), 'texto da Ana');
      fs.mkdirSync(path.join(profilesRoot, 'ana', 'Documentos'));

      const opened = await manager.openFolder(HOST_ID, 'ana');
      expect(opened).toMatchObject({ ok: true, account: 'ana', label: 'Ana', pcName: 'PC-B' });
      expect(fileTransferSession.isReadOnly(opened.sessionId)).toBe(true);
      const client = fileTransferSession.getClient(opened.sessionId);

      const entries = await client.list('/');
      expect(entries.map((entry) => entry.name).sort()).toEqual(['Documentos', 'trabalho.txt']);
      const target = path.join(profilesRoot, '..', `baixado-${Date.now()}.txt`);
      await client.downloadToFile('/trabalho.txt', target);
      expect(fs.readFileSync(target, 'utf8')).toBe('texto da Ana');
      fs.rmSync(target, { force: true });

      await expect(client.mkdir('/nova')).rejects.toThrow(/somente leitura/);
      await expect(client.remove('/trabalho.txt')).rejects.toThrow(/somente leitura/);
      await expect(client.rename('/trabalho.txt', '/outro.txt')).rejects.toThrow(/somente leitura/);
      const upload = path.join(profilesRoot, '..', `envio-${Date.now()}.txt`);
      fs.writeFileSync(upload, 'x');
      await expect(client.uploadFromFile(upload, '/envio.txt')).rejects.toThrow();
      fs.rmSync(upload, { force: true });
      await expect(client.list('/../')).rejects.toThrow();
      expect(fs.existsSync(path.join(profilesRoot, 'ana', 'nova'))).toBe(false);
      expect(fs.existsSync(path.join(profilesRoot, 'ana', 'envio.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(profilesRoot, 'ana', 'trabalho.txt'), 'utf8')).toBe(
        'texto da Ana',
      );

      // Uma conexão comum ao mesmo PC não reaproveita a sessão somente leitura.
      expect(fileTransferSession.getVncTunnelToken('127.0.0.1')).toBe('');
    },
  );
});
