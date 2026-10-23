import { describe, expect, it, vi } from 'vitest';
import { createHandoverPublisher } from '../handover-publisher.js';
import { createFakeDb, find } from '../../access/__tests__/fake-db.js';

const TEACHER = { id: 'teacher-1', role: 'professor' };
const HOST = 'host-1';
const PASSWORD = 'Xk29-pass-77';

const credentials = (extra = {}) => ({
  reservationId: 'r-1',
  account: 'ana',
  userName: 'PC1\\ana',
  password: PASSWORD,
  startBy: Date.UTC(2026, 9, 22, 15, 30),
  endsAt: Date.UTC(2026, 9, 22, 17, 0),
  ...extra,
});
const reserved = (extra = {}) => ({
  ok: true,
  credentials: credentials(),
  pc: { hostId: HOST, name: 'PC 1', host: '100.64.0.7' },
  ...extra,
});

function build({
  db = createFakeDb(),
  context = { client: db, profile: TEACHER },
  ...options
} = {}) {
  const logs = [];
  const publisher = createHandoverPublisher({
    getContext: () => (context ? { ...context, client: db } : null),
    log: (line) => logs.push(line),
    ...options,
  });
  return { publisher, db, logs };
}

const linked = (extra = {}) => ({
  'lab_student_links.select': {
    data: { student_id: 'student-1', label: 'Ana', ...extra },
    error: null,
  },
});

describe('reservar', () => {
  it('apaga o acesso anterior do PC e publica o novo, com tudo que o aluno precisa', async () => {
    const db = createFakeDb(linked());
    const { publisher } = build({ db });
    const published = await publisher.afterReserve(HOST, reserved());

    expect(published).toEqual({ status: 'sent', message: 'Enviado para o app de Ana' });
    expect(db.ops.map((op) => `${op.table}.${op.kind}`)).toEqual([
      'lab_student_links.select',
      'lab_handovers.delete',
      'lab_handovers.insert',
    ]);
    expect(db.ops[0].filters).toEqual([
      ['eq', 'host_id', HOST],
      ['eq', 'windows_account', 'ana'],
    ]);
    expect(db.ops[1].filters).toEqual([['eq', 'host_id', HOST]]);
    expect(db.ops[2].payload).toEqual({
      student_id: 'student-1',
      created_by: TEACHER.id,
      reservation_id: 'r-1',
      host_id: HOST,
      host_name: 'PC 1',
      host_address: '100.64.0.7',
      windows_user: 'PC1\\ana',
      password: PASSWORD,
      start_by: '2026-10-22T15:30:00.000Z',
      ends_at: '2026-10-22T17:00:00.000Z',
    });
  });

  it('a troca de aluno publica o novo e já tirou o acesso do anterior', async () => {
    const db = createFakeDb(linked({ label: 'João' }));
    const { publisher } = build({ db });
    const published = await publisher.afterReserve(
      HOST,
      reserved({
        credentials: credentials({ account: 'joao', reservationId: 'r-2' }),
        previous: { account: 'ana', label: 'Ana' },
      }),
    );
    expect(published.message).toBe('Enviado para o app de João');
    expect(find(db, 'lab_handovers', 'delete')).toHaveLength(1);
    expect(find(db, 'lab_handovers', 'insert')[0].payload.reservation_id).toBe('r-2');
  });

  it('aluno sem conta vinculada: nada é publicado, o acesso antigo sai e o professor é avisado', async () => {
    const db = createFakeDb(); // sem vínculo
    const { publisher } = build({ db });
    const published = await publisher.afterReserve(HOST, reserved());
    expect(published.status).toBe('skipped');
    expect(published.message).toContain('ana');
    expect(published.message).toContain('Copiar mensagem');
    expect(find(db, 'lab_handovers', 'delete')).toHaveLength(1);
    expect(find(db, 'lab_handovers', 'insert')).toHaveLength(0);
  });

  it('uma falha do banco nunca lança: vira { status: "failed" } e a reserva segue valendo', async () => {
    const db = createFakeDb({
      ...linked(),
      'lab_handovers.insert': {
        data: null,
        error: { code: '42501', message: 'new row violates row-level security policy' },
      },
    });
    const { publisher, logs } = build({ db });
    const published = await publisher.afterReserve(HOST, reserved());
    expect(published.status).toBe('failed');
    expect(published.message).toBe('Só professores aprovados podem fazer isso');
    expect(published.message).not.toContain('row-level');
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });

  it('sem rede: a mensagem diz isso', async () => {
    const db = createFakeDb({
      'lab_student_links.select': () => ({
        data: null,
        error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }),
      }),
    });
    const { publisher } = build({ db });
    expect((await publisher.afterReserve(HOST, reserved())).message).toMatch(/Sem conexão/);
  });

  it('servidor que não responde: desiste no prazo e não trava a tela', async () => {
    const db = createFakeDb({ 'lab_student_links.select': () => new Promise(() => {}) });
    const { publisher } = build({ db, timeoutMs: 20 });
    const started = Date.now();
    const published = await publisher.afterReserve(HOST, reserved());
    expect(published.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('sem horário de término não publica', async () => {
    const db = createFakeDb(linked());
    const { publisher } = build({ db });
    const published = await publisher.afterReserve(
      HOST,
      reserved({ credentials: credentials({ endsAt: 0 }) }),
    );
    expect(published.status).toBe('failed');
    expect(find(db, 'lab_handovers', 'insert')).toHaveLength(0);
  });

  it('sem professor conectado (build sem contas, "sem conta") não faz nada e não diz nada', async () => {
    const db = createFakeDb(linked());
    const { publisher } = build({ db, context: null });
    expect(await publisher.afterReserve(HOST, reserved())).toBeNull();
    expect(db.ops).toEqual([]);
  });

  it('a senha nunca aparece em log, resposta ou mensagem', async () => {
    const db = createFakeDb({
      ...linked(),
      'lab_handovers.insert': {
        data: null,
        error: { code: 'XX000', message: `senha ${PASSWORD} no erro` },
      },
    });
    const { publisher, logs } = build({ db });
    const results = [
      await publisher.afterReserve(HOST, reserved()),
      await publisher.afterReserve(HOST, reserved({ credentials: credentials({ endsAt: 0 }) })),
    ];
    expect(JSON.stringify({ results, logs })).not.toContain(PASSWORD);
  });

  it('uma reserva que falhou, ou resposta sem credenciais, não publica nada', async () => {
    const db = createFakeDb(linked());
    const { publisher } = build({ db });
    expect(await publisher.afterReserve(HOST, { ok: false, error: 'busy' })).toBeNull();
    expect(await publisher.afterReserve(HOST, { ok: true })).toBeNull();
    expect(await publisher.afterReserve(HOST, undefined)).toBeNull();
    expect(db.ops).toEqual([]);
  });

  it('troca em que o aluno anterior saiu mas o próximo não foi reservado: o acesso antigo é apagado', async () => {
    const db = createFakeDb();
    const { publisher } = build({ db });
    expect(
      await publisher.afterReserve(HOST, { ok: false, step: 'reserve', ended: true }),
    ).toBeNull();
    expect(find(db, 'lab_handovers', 'delete')).toHaveLength(1);

    const untouched = createFakeDb();
    const second = build({ db: untouched });
    await second.publisher.afterReserve(HOST, {
      ok: false,
      step: 'end',
      message: 'falhou o logoff',
    });
    expect(untouched.ops).toEqual([]);
  });
});

describe('estender e encerrar', () => {
  it('estender atualiza só o horário de término do acesso do PC', async () => {
    const db = createFakeDb();
    const { publisher } = build({ db });
    const published = await publisher.afterExtend(HOST, {
      ok: true,
      reservationId: 'r-1',
      endsAt: Date.UTC(2026, 9, 22, 18, 0),
    });
    expect(published).toEqual({ status: 'sent', message: 'Novo horário enviado ao app do aluno' });
    const [op] = find(db, 'lab_handovers', 'update');
    expect(op.payload).toEqual({ ends_at: '2026-10-22T18:00:00.000Z' });
    expect(op.filters).toEqual([['eq', 'host_id', HOST]]);
  });

  it('estender falhou ou sem novo horário: nada a fazer; erro do banco vira frase', async () => {
    const db = createFakeDb({ 'lab_handovers.update': { data: null, error: { code: '42501' } } });
    const { publisher } = build({ db });
    expect(await publisher.afterExtend(HOST, { ok: false })).toBeNull();
    expect(await publisher.afterExtend(HOST, { ok: true, endsAt: 0 })).toBeNull();
    expect(db.ops).toEqual([]);
    const failed = await publisher.afterExtend(HOST, { ok: true, endsAt: Date.now() + 1000 });
    expect(failed.status).toBe('failed');
  });

  it('encerrar apaga o acesso do PC; se encerrar falhou, mantém', async () => {
    const db = createFakeDb();
    const { publisher } = build({ db });
    expect(await publisher.afterEnd(HOST, { ok: false })).toBeNull();
    expect(db.ops).toEqual([]);
    expect(await publisher.afterEnd(HOST, { ok: true })).toBeNull();
    expect(find(db, 'lab_handovers', 'delete')[0].filters).toEqual([['eq', 'host_id', HOST]]);
  });

  it('encerrar com falha no banco avisa o professor (o acesso some pelo prazo e pela limpeza)', async () => {
    const db = createFakeDb({ 'lab_handovers.delete': { data: null, error: { code: 'XX' } } });
    const { publisher } = build({ db });
    expect((await publisher.afterEnd(HOST, { ok: true })).status).toBe('failed');
  });

  it('um contexto que muda no meio (professor saiu) não derruba nada', async () => {
    const getContext = vi
      .fn()
      .mockReturnValueOnce({ client: createFakeDb(), profile: TEACHER })
      .mockReturnValue(null);
    const publisher = createHandoverPublisher({ getContext });
    expect(await publisher.afterEnd(HOST, { ok: true })).toBeNull();
    expect(await publisher.afterEnd(HOST, { ok: true })).toBeNull();
  });
});
