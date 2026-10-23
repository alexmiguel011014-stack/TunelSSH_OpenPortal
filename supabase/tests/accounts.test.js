import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, asUser, createDb, makeTeacher, profileOf, run, signUp } from './harness.js';

// G20-S2: as regras de contas, provadas contra um Postgres de verdade (ver harness.js).
let db;
let counter = 0;
const email = (name) => `${name}${++counter}@example.com`;

beforeAll(async () => {
  db = await createDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('cadastro (gatilho em auth.users)', () => {
  it('cria um aluno com o nome e o e-mail informados', async () => {
    const user = await signUp(db, { email: email('ana'), meta: { full_name: 'Ana Souza' } });
    const profile = await profileOf(db, user);
    expect(profile).toMatchObject({
      email: user.email,
      full_name: 'Ana Souza',
      role: 'aluno',
      teacher_requested_at: null,
      approved_by: null,
    });
  });

  it('ignora qualquer papel vindo dos metadados do cliente', async () => {
    for (const meta of [
      { full_name: 'Esperto', role: 'professor' },
      { full_name: 'Esperto', user_role: 'professor' },
      { full_name: 'Esperto', is_teacher: true, role: 'service_role' },
    ]) {
      const user = await signUp(db, { email: email('esperto'), meta });
      expect((await profileOf(db, user)).role).toBe('aluno');
    }
  });

  it('wants_teacher só abre um pedido: continua aluno, com a data do pedido', async () => {
    for (const wants of [true, 'true']) {
      const user = await signUp(db, {
        email: email('prof'),
        meta: { full_name: 'Prof Pedro', wants_teacher: wants },
      });
      const profile = await profileOf(db, user);
      expect(profile.role).toBe('aluno');
      expect(profile.teacher_requested_at).not.toBeNull();
    }
    const no = await signUp(db, { email: email('no'), meta: { wants_teacher: false } });
    expect((await profileOf(db, no)).teacher_requested_at).toBeNull();
  });

  it('limpa o nome: apara, tira caracteres de controle e corta em 80', async () => {
    const messy = await signUp(db, {
      email: email('messy'),
      meta: { full_name: '  Bia\u0007\u001b Lima \n' },
    });
    expect((await profileOf(db, messy)).full_name).toBe('Bia Lima');

    const long = await signUp(db, { email: email('long'), meta: { full_name: 'x'.repeat(500) } });
    expect((await profileOf(db, long)).full_name).toHaveLength(80);
  });

  it('sem nome usa a parte local do e-mail; sem metadados nenhum, também funciona', async () => {
    const noName = await signUp(db, {
      email: 'carlos.dias@example.com',
      meta: { full_name: '  ' },
    });
    expect((await profileOf(db, noName)).full_name).toBe('carlos.dias');
    const bare = await signUp(db, { email: email('bare') });
    expect((await profileOf(db, bare)).role).toBe('aluno');
  });
});

describe('aluno', () => {
  it('lê só o próprio perfil', async () => {
    const ana = await signUp(db, { email: email('ana'), meta: { full_name: 'Ana' } });
    await signUp(db, { email: email('joao'), meta: { full_name: 'João' } });
    const { rows } = await run(db, asUser(ana), 'select id from public.profiles');
    expect(rows).toEqual([{ id: ana.id }]);
  });

  it('muda o próprio nome, e só o nome', async () => {
    const ana = await signUp(db, { email: email('ana'), meta: { full_name: 'Ana' } });
    const changed = await run(
      db,
      asUser(ana),
      "update public.profiles set full_name = 'Ana Maria' where id = $1 returning full_name",
      [ana.id],
    );
    expect(changed.rows).toEqual([{ full_name: 'Ana Maria' }]);

    for (const column of ['role', 'teacher_requested_at', 'approved_by', 'email', 'id']) {
      const value = column === 'role' ? "'professor'" : column === 'email' ? "'x@y.z'" : 'null';
      const target = column === 'id' ? `gen_random_uuid()` : value;
      await expect(
        run(db, asUser(ana), `update public.profiles set ${column} = ${target} where id = $1`, [
          ana.id,
        ]),
      ).rejects.toThrow(/permission denied/);
    }
    expect((await profileOf(db, ana)).role).toBe('aluno');
  });

  it('não altera o perfil de outra pessoa', async () => {
    const ana = await signUp(db, { email: email('ana'), meta: { full_name: 'Ana' } });
    const joao = await signUp(db, { email: email('joao'), meta: { full_name: 'João' } });
    const result = await run(
      db,
      asUser(ana),
      "update public.profiles set full_name = 'Hackeado' where id = $1",
      [joao.id],
    );
    expect(result.affectedRows).toBe(0);
    expect((await profileOf(db, joao)).full_name).toBe('João');
  });

  it('não cria nem apaga perfis', async () => {
    const ana = await signUp(db, { email: email('ana') });
    await expect(
      run(
        db,
        asUser(ana),
        "insert into public.profiles (id, email, full_name, role) values (gen_random_uuid(), 'a@b.c', 'X', 'professor')",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      run(db, asUser(ana), 'delete from public.profiles where id = $1', [ana.id]),
    ).rejects.toThrow(/permission denied/);
  });

  it('não decide pedido de professor, nem o próprio', async () => {
    const wannabe = await signUp(db, {
      email: email('wannabe'),
      meta: { full_name: 'Quase', wants_teacher: true },
    });
    for (const fn of ['approve_teacher', 'refuse_teacher']) {
      await expect(
        run(db, asUser(wannabe), `select public.${fn}($1)`, [wannabe.id]),
      ).rejects.toThrow(/only a teacher can decide a request/);
    }
    const profile = await profileOf(db, wannabe);
    expect(profile.role).toBe('aluno');
    expect(profile.teacher_requested_at).not.toBeNull();
  });

  it('is_teacher() é falso para aluno e para pedido pendente', async () => {
    const wannabe = await signUp(db, { email: email('w'), meta: { wants_teacher: true } });
    const { rows } = await run(db, asUser(wannabe), 'select public.is_teacher() as ok');
    expect(rows[0].ok).toBe(false);
  });
});

describe('professor', () => {
  it('lê todos os perfis e lista os pedidos pendentes', async () => {
    const teacher = await makeTeacher(db, await signUp(db, { email: email('t'), meta: {} }));
    const pending = await signUp(db, {
      email: email('pend'),
      meta: { full_name: 'Pendente', wants_teacher: true },
    });
    await signUp(db, { email: email('plain'), meta: { full_name: 'Comum' } });

    const all = await run(db, asUser(teacher), 'select count(*)::int as n from public.profiles');
    const total = await db.query('select count(*)::int as n from public.profiles');
    expect(all.rows[0].n).toBe(total.rows[0].n);

    const requests = await run(
      db,
      asUser(teacher),
      "select id from public.profiles where role = 'aluno' and teacher_requested_at is not null",
    );
    expect(requests.rows.map((row) => row.id)).toContain(pending.id);
  });

  it('aprova um pedido: vira professor, guarda quem aprovou e limpa o pedido', async () => {
    const teacher = await makeTeacher(db, await signUp(db, { email: email('t'), meta: {} }));
    const pending = await signUp(db, { email: email('p'), meta: { wants_teacher: true } });

    await run(db, asUser(teacher), 'select public.approve_teacher($1)', [pending.id]);
    expect(await profileOf(db, pending)).toMatchObject({
      role: 'professor',
      approved_by: teacher.id,
      teacher_requested_at: null,
    });
  });

  it('recusa um pedido: continua aluno e o pedido some', async () => {
    const teacher = await makeTeacher(db, await signUp(db, { email: email('t'), meta: {} }));
    const pending = await signUp(db, { email: email('p'), meta: { wants_teacher: true } });

    await run(db, asUser(teacher), 'select public.refuse_teacher($1)', [pending.id]);
    expect(await profileOf(db, pending)).toMatchObject({
      role: 'aluno',
      teacher_requested_at: null,
      approved_by: null,
    });
  });

  it('não aprova quem não pediu, quem já é professor, nem um id que não existe', async () => {
    const teacher = await makeTeacher(db, await signUp(db, { email: email('t'), meta: {} }));
    const plain = await signUp(db, { email: email('plain'), meta: {} });
    const other = await makeTeacher(db, await signUp(db, { email: email('t2'), meta: {} }));

    for (const target of [plain.id, other.id, '00000000-0000-0000-0000-000000000000']) {
      await expect(
        run(db, asUser(teacher), 'select public.approve_teacher($1)', [target]),
      ).rejects.toThrow(/no pending teacher request/);
    }
    expect((await profileOf(db, plain)).role).toBe('aluno');
  });

  it('um pedido já decidido não se decide de novo', async () => {
    const teacher = await makeTeacher(db, await signUp(db, { email: email('t'), meta: {} }));
    const pending = await signUp(db, { email: email('p'), meta: { wants_teacher: true } });
    await run(db, asUser(teacher), 'select public.refuse_teacher($1)', [pending.id]);
    await expect(
      run(db, asUser(teacher), 'select public.approve_teacher($1)', [pending.id]),
    ).rejects.toThrow(/no pending teacher request/);
  });

  it('o banco recusa um professor com pedido pendente (G20-S3 precisa limpar o pedido)', async () => {
    const pending = await signUp(db, { email: email('p'), meta: { wants_teacher: true } });
    await expect(
      db.query("update public.profiles set role = 'professor' where id = $1", [pending.id]),
    ).rejects.toThrow(/profiles_request_only_for_students/);
  });
});

describe('anon e proteção geral', () => {
  it('quem não entrou não lê perfis nem chama as funções de conta', async () => {
    await expect(run(db, anon, 'select * from public.profiles')).rejects.toThrow(
      /permission denied/,
    );
    for (const call of [
      'public.is_teacher()',
      'public.approve_teacher(gen_random_uuid())',
      'public.refuse_teacher(gen_random_uuid())',
    ]) {
      await expect(run(db, anon, `select ${call}`)).rejects.toThrow(/permission denied/);
    }
  });

  it('ping() responde a quem não entrou (mantém o projeto acordado)', async () => {
    const { rows } = await run(db, anon, 'select public.ping() as now');
    expect(rows[0].now).toBeInstanceOf(Date);
  });

  it('toda tabela de public tem RLS ligada e nada é concedido ao anon', async () => {
    const tables = await db.query(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(tables.rows.length).toBeGreaterThan(0);
    for (const table of tables.rows) expect(table.relrowsecurity, table.relname).toBe(true);

    const grants = await db.query(
      `select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'anon'`,
    );
    expect(grants.rows).toEqual([]);
  });

  it('só ping() pode ser executada por anon ou por qualquer um (public)', async () => {
    const { rows } = await db.query(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (has_function_privilege('anon', p.oid, 'execute')
               or has_function_privilege('public', p.oid, 'execute'))`,
    );
    expect(rows.map((row) => row.proname)).toEqual(['ping']);
  });
});
