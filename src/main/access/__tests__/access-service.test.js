import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanQuery, createAccessService } from '../access-service.js';
import { createFakeDb, find } from './fake-db.js';

const TEACHER = {
  id: 'teacher-1',
  role: 'professor',
  fullName: 'Prof',
  email: 'p@x.com',
  teacherPending: false,
};
const STUDENT = {
  id: 'student-1',
  role: 'aluno',
  fullName: 'Ana',
  email: 'a@x.com',
  teacherPending: false,
};
const HOST = 'host-1';
const NOW = Date.UTC(2026, 9, 22, 15, 0, 0);

function fakeAuth({ profile = TEACHER, status = 'signed-in', db = createFakeDb() } = {}) {
  let state = { status, profile };
  const listeners = new Set();
  return {
    db,
    set(next) {
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
    },
    auth: {
      getClient: () => (state.status === 'unconfigured' ? null : db),
      getProfile: () => state.profile,
      getState: () => state,
      onState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

const handoverRow = (extra = {}) => ({
  id: 'h-1',
  host_name: 'PC 1',
  host_address: '100.64.0.7',
  windows_user: 'PC1\\ana',
  password: 'Xk29-pass-77',
  start_by: '2026-10-22T15:30:00.000Z',
  ends_at: '2026-10-22T17:00:00.000Z',
  ...extra,
});

function build(options = {}) {
  const world = fakeAuth(options);
  const logs = [];
  const clipboard = {
    text: '',
    writeText: vi.fn((t) => (clipboard.text = t)),
    readText: () => clipboard.text,
    clear: vi.fn(() => (clipboard.text = '')),
  };
  const rdpLauncher = { open: vi.fn(() => ({ ok: true })) };
  const pushed = [];
  const service = createAccessService({
    auth: world.auth,
    clipboard,
    rdpLauncher,
    now: () => options.now ?? NOW,
    onMineChanged: (access) => pushed.push(access),
    log: (line) => logs.push(line),
    pollMs: 1000,
    clipboardClearMs: 60_000,
  });
  return { ...world, service, logs, clipboard, rdpLauncher, pushed };
}

describe('cleanQuery', () => {
  it('deixa só letras, números, espaço e @ . _ + -', () => {
    expect(cleanQuery('  ana.souza@x.com ')).toBe('ana.souza@x.com');
    expect(cleanQuery('João da Silva')).toBe('João da Silva');
    expect(cleanQuery('a,b(c)%*"\\')).toBe('abc');
    expect(cleanQuery('x'.repeat(100))).toHaveLength(40);
    expect(cleanQuery(null)).toBe('');
  });
});

describe('professor: procurar alunos e vincular', () => {
  it('só professor procura, vincula e desvincula; o banco nem é consultado', async () => {
    const { service, db } = build({ profile: STUDENT });
    for (const result of [
      await service.searchStudents('ana'),
      await service.listLinks(HOST),
      await service.link({ hostId: HOST, account: 'ana', label: 'Ana', studentId: 's' }),
      await service.unlink({ hostId: HOST, account: 'ana' }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: 'not-teacher' });
    }
    expect(db.ops).toEqual([]);
  });

  it('sem projeto configurado nada funciona e diz isso', async () => {
    const { service } = build({ status: 'unconfigured' });
    expect(await service.searchStudents('a')).toMatchObject({ ok: false, error: 'unconfigured' });
  });

  it('a busca pede só alunos, em ordem, e limpa o texto antes de montar o filtro', async () => {
    const db = createFakeDb({
      'profiles.select': {
        data: [{ id: 'u1', email: 'ana@x.com', full_name: 'Ana Souza' }],
        error: null,
      },
    });
    const { service } = build({ db });
    const result = await service.searchStudents('ana, (x)%');

    expect(result).toEqual({
      ok: true,
      students: [{ id: 'u1', email: 'ana@x.com', fullName: 'Ana Souza' }],
    });
    const [op] = db.ops;
    expect(op.filters).toContainEqual(['eq', 'role', 'aluno']);
    expect(op.filters).toContainEqual(['or', 'full_name.ilike.%ana x%,email.ilike.%ana x%']);
    expect(op.modifiers).toContainEqual(['limit', 20]);
  });

  it('busca vazia lista os primeiros alunos, sem filtro de texto', async () => {
    const db = createFakeDb({ 'profiles.select': { data: [], error: null } });
    const { service } = build({ db });
    await service.searchStudents('');
    expect(db.ops[0].filters.some((filter) => filter[0] === 'or')).toBe(false);
  });

  it('lista os vínculos de um PC com o e-mail de cada aluno', async () => {
    const db = createFakeDb({
      'lab_student_links.select': {
        data: [{ windows_account: 'ana', student_id: 'u1', label: 'Ana', linked_at: '2026-10-22' }],
        error: null,
      },
      'profiles.select': {
        data: [{ id: 'u1', email: 'ana@x.com', full_name: 'Ana Souza' }],
        error: null,
      },
    });
    const { service } = build({ db });
    expect(await service.listLinks(HOST)).toEqual({
      ok: true,
      links: [
        {
          account: 'ana',
          studentId: 'u1',
          label: 'Ana',
          email: 'ana@x.com',
          fullName: 'Ana Souza',
        },
      ],
    });
    expect(find(db, 'lab_student_links', 'select')[0].filters).toContainEqual([
      'eq',
      'host_id',
      HOST,
    ]);
  });

  it('sem vínculos não consulta os perfis', async () => {
    const db = createFakeDb();
    const { service } = build({ db });
    expect(await service.listLinks(HOST)).toEqual({ ok: true, links: [] });
    expect(find(db, 'profiles', 'select')).toHaveLength(0);
  });

  it('vincular troca os vínculos antigos da conta e do aluno e grava o novo em nome do professor', async () => {
    const db = createFakeDb();
    const { service } = build({ db });
    const result = await service.link({
      hostId: HOST,
      account: 'ana',
      label: 'Ana',
      studentId: 'u1',
    });
    expect(result).toEqual({ ok: true });

    const deletes = find(db, 'lab_student_links', 'delete');
    expect(deletes.map((op) => op.filters)).toEqual([
      [
        ['eq', 'host_id', HOST],
        ['eq', 'windows_account', 'ana'],
      ],
      [
        ['eq', 'host_id', HOST],
        ['eq', 'student_id', 'u1'],
      ],
    ]);
    expect(find(db, 'lab_student_links', 'insert')[0].payload).toEqual({
      host_id: HOST,
      windows_account: 'ana',
      student_id: 'u1',
      label: 'Ana',
      linked_by: TEACHER.id,
    });
  });

  it('um erro do banco vira frase em português, sem detalhe interno', async () => {
    const db = createFakeDb({
      'lab_student_links.insert': {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "x"' },
      },
    });
    const { service, logs } = build({ db });
    const result = await service.link({
      hostId: HOST,
      account: 'ana',
      label: 'Ana',
      studentId: 'u1',
    });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('duplicate key');
    expect(logs.join('\n')).not.toContain('duplicate key');
  });

  it('desvincula pela conta do Windows no PC', async () => {
    const db = createFakeDb();
    const { service } = build({ db });
    expect(await service.unlink({ hostId: HOST, account: 'ana' })).toEqual({ ok: true });
    expect(find(db, 'lab_student_links', 'delete')[0].filters).toEqual([
      ['eq', 'host_id', HOST],
      ['eq', 'windows_account', 'ana'],
    ]);
  });
});

describe('aluno: o acesso liberado', () => {
  it('lê o acesso que vale agora e o entrega com os horários em milissegundos', async () => {
    const db = createFakeDb({ 'lab_handovers.select': { data: [handoverRow()], error: null } });
    const { service } = build({ profile: STUDENT, db });
    const result = await service.mine();

    expect(result).toEqual({
      ok: true,
      access: {
        id: 'h-1',
        hostName: 'PC 1',
        address: '100.64.0.7',
        userName: 'PC1\\ana',
        password: 'Xk29-pass-77',
        startBy: Date.parse('2026-10-22T15:30:00.000Z'),
        endsAt: Date.parse('2026-10-22T17:00:00.000Z'),
      },
    });
    const [op] = db.ops;
    expect(op.filters).toContainEqual(['gt', 'ends_at', new Date(NOW).toISOString()]);
    expect(op.modifiers).toContainEqual(['limit', 1]);
  });

  it('sem acesso liberado devolve null; quem não é aluno nem consulta', async () => {
    const student = build({ profile: STUDENT });
    expect(await student.service.mine()).toEqual({ ok: true, access: null });

    const teacher = build({ profile: TEACHER });
    expect(await teacher.service.mine()).toEqual({ ok: true, access: null });
    expect(teacher.db.ops).toEqual([]);
  });

  it('uma linha estragada não vira acesso', async () => {
    const db = createFakeDb({
      'lab_handovers.select': { data: [handoverRow({ ends_at: 'ontem' })], error: null },
    });
    const { service } = build({ profile: STUDENT, db });
    expect((await service.mine()).access).toBeNull();
  });

  it('falha de rede devolve a frase e mantém o cartão anterior até o prazo', async () => {
    let fail = false;
    const db = createFakeDb({
      'lab_handovers.select': () =>
        fail
          ? {
              data: null,
              error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }),
            }
          : { data: [handoverRow()], error: null },
    });
    let now = NOW;
    const world = fakeAuth({ profile: STUDENT, db });
    const service = createAccessService({
      auth: world.auth,
      clipboard: {},
      rdpLauncher: { open: vi.fn(() => ({ ok: true })) },
      now: () => now,
    });
    await service.mine();
    fail = true;
    expect(await service.mine()).toMatchObject({ ok: false, error: 'network' });
    expect(service.openRdp()).toEqual({ ok: true }); // o acesso anterior ainda vale

    now = Date.parse('2026-10-22T17:00:01.000Z'); // passou do prazo
    expect(service.openRdp()).toMatchObject({ ok: false, error: 'no-access' });
  });

  describe('acompanhamento em tempo real', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('assina as mudanças, entrega o acesso à tela e reage a um evento', async () => {
      let rows = [handoverRow()];
      const db = createFakeDb({ 'lab_handovers.select': () => ({ data: rows, error: null }) });
      const { service, pushed } = build({ profile: STUDENT, db });

      service.syncWatching();
      await vi.advanceTimersByTimeAsync(0);
      expect(db.channels).toHaveLength(1);
      expect(db.channels[0].subscribed).toBe(true);
      expect(db.channels[0].handlers[0].filter).toMatchObject({
        table: 'lab_handovers',
        event: '*',
      });
      expect(pushed).toHaveLength(1);
      expect(pushed[0].userName).toBe('PC1\\ana');

      // Um evento (o professor trocou de aluno): relê e empurra o novo estado.
      rows = [];
      db.channels[0].handlers[0].callback({});
      await vi.advanceTimersByTimeAsync(0);
      expect(pushed.at(-1)).toBeNull();
      service.stop();
    });

    it('relê sozinho a cada minuto e não repete o que já entregou', async () => {
      const db = createFakeDb({ 'lab_handovers.select': { data: [handoverRow()], error: null } });
      const { service, pushed } = build({ profile: STUDENT, db });
      service.syncWatching();
      await vi.advanceTimersByTimeAsync(3500);
      expect(find(db, 'lab_handovers', 'select').length).toBeGreaterThanOrEqual(4);
      expect(pushed).toHaveLength(1);
      service.stop();
    });

    it('ao sair (ou virar professor) para de acompanhar, fecha o canal e limpa o cartão', async () => {
      const db = createFakeDb({ 'lab_handovers.select': { data: [handoverRow()], error: null } });
      const { service, pushed, set } = build({ profile: STUDENT, db });
      service.syncWatching();
      await vi.advanceTimersByTimeAsync(0);
      expect(pushed).toHaveLength(1);

      set({ status: 'signed-out', profile: null });
      service.syncWatching();
      expect(db.removeChannel).toHaveBeenCalledTimes(1);
      expect(db.channels[0].removed).toBe(true);
      expect(pushed.at(-1)).toBeNull();
      const reads = find(db, 'lab_handovers', 'select').length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(find(db, 'lab_handovers', 'select').length).toBe(reads);
      expect(service.openRdp()).toMatchObject({ error: 'no-access' });
    });

    it('um professor nunca acompanha acessos', async () => {
      const db = createFakeDb();
      const { service } = build({ profile: TEACHER, db });
      service.syncWatching();
      await vi.advanceTimersByTimeAsync(2000);
      expect(db.channels).toEqual([]);
      expect(db.ops).toEqual([]);
    });
  });

  it('abrir a Área de Trabalho Remota usa o que o processo principal leu, não o que a tela mandar', async () => {
    const db = createFakeDb({ 'lab_handovers.select': { data: [handoverRow()], error: null } });
    const { service, rdpLauncher } = build({ profile: STUDENT, db });
    expect(service.openRdp()).toMatchObject({ ok: false, error: 'no-access' });
    expect(rdpLauncher.open).not.toHaveBeenCalled();

    await service.mine();
    service.openRdp({ address: '6.6.6.6', userName: 'hacker' });
    expect(rdpLauncher.open).toHaveBeenCalledWith({ address: '100.64.0.7', userName: 'PC1\\ana' });
  });

  describe('copiar a senha', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    async function withAccess() {
      const db = createFakeDb({ 'lab_handovers.select': { data: [handoverRow()], error: null } });
      const built = build({ profile: STUDENT, db });
      await built.service.mine();
      return built;
    }

    it('copia e limpa a área de transferência em 1 minuto, se ainda tiver a senha', async () => {
      const { service, clipboard } = await withAccess();
      expect(service.copyPassword()).toEqual({ ok: true, clearsInSeconds: 60 });
      expect(clipboard.text).toBe('Xk29-pass-77');
      await vi.advanceTimersByTimeAsync(59_000);
      expect(clipboard.clear).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(clipboard.clear).toHaveBeenCalledTimes(1);
      expect(clipboard.text).toBe('');
    });

    it('não apaga o que a pessoa copiou depois', async () => {
      const { service, clipboard } = await withAccess();
      service.copyPassword();
      clipboard.text = 'outra coisa que a pessoa copiou';
      await vi.advanceTimersByTimeAsync(61_000);
      expect(clipboard.clear).not.toHaveBeenCalled();
      expect(clipboard.text).toBe('outra coisa que a pessoa copiou');
    });

    it('sem acesso não copia nada', () => {
      const { service, clipboard } = build({ profile: STUDENT });
      expect(service.copyPassword()).toMatchObject({ ok: false, error: 'no-access' });
      expect(clipboard.writeText).not.toHaveBeenCalled();
    });
  });

  it('a senha não aparece em nenhum log', async () => {
    const db = createFakeDb({
      'lab_handovers.select': { data: [handoverRow()], error: null },
    });
    const { service, logs } = build({ profile: STUDENT, db });
    await service.mine();
    service.copyPassword();
    service.openRdp();
    expect(logs.join('\n')).not.toContain('Xk29-pass-77');
  });
});
