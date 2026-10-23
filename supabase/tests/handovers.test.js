import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, asUser, createDb, makeTeacher, run, signUp } from './harness.js';

// G21-S2: as regras de "Meu acesso", provadas contra um Postgres de verdade (ver harness.js).
let db;
let counter = 0;
const email = (name) => `${name}${++counter}@example.com`;
const uuid = () => '00000000-0000-4000-8000-' + String(++counter).padStart(12, '0');

beforeAll(async () => {
  db = await createDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function world() {
  const teacher = await makeTeacher(db, await signUp(db, { email: email('prof'), meta: {} }));
  const other = await makeTeacher(db, await signUp(db, { email: email('prof2'), meta: {} }));
  const ana = await signUp(db, { email: email('ana'), meta: { full_name: 'Ana' } });
  const joao = await signUp(db, { email: email('joao'), meta: { full_name: 'João' } });
  const pending = await signUp(db, { email: email('pend'), meta: { wants_teacher: true } });
  return { teacher, other, ana, joao, pending };
}

const INSERT = `insert into public.lab_handovers
  (student_id, created_by, reservation_id, host_id, host_name, host_address, windows_user,
   password, start_by, ends_at)
  values ($1, $2, 'r-1', 'host-1', 'PC 1', '100.64.0.7', 'PC1\\ana', 'Xk29-pass-77',
          now() + interval '30 minutes', now() + $3::interval)
  returning id`;

const publish = (db_, teacher, student, interval = '2 hours') =>
  run(db_, asUser(teacher), INSERT, [student.id, teacher.id, interval]);

describe('acessos entregues (lab_handovers)', () => {
  it('o professor publica e o aluno enxerga o próprio acesso, com a senha', async () => {
    const { teacher, ana } = await world();
    await publish(db, teacher, ana);

    const { rows } = await run(
      db,
      asUser(ana),
      'select host_name, host_address, windows_user, password from public.lab_handovers',
    );
    expect(rows).toEqual([
      {
        host_name: 'PC 1',
        host_address: '100.64.0.7',
        windows_user: 'PC1\\ana',
        password: 'Xk29-pass-77',
      },
    ]);
  });

  it('outro aluno, um professor pendente e quem não entrou não enxergam nada', async () => {
    const { teacher, ana, joao, pending } = await world();
    await publish(db, teacher, ana);

    for (const reader of [joao, pending]) {
      const { rows } = await run(db, asUser(reader), 'select id from public.lab_handovers');
      expect(rows).toEqual([]);
    }
    await expect(run(db, anon, 'select * from public.lab_handovers')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('depois de ends_at o aluno deixa de ver o acesso; o professor ainda vê até a limpeza', async () => {
    const { teacher, ana } = await world();
    const { rows } = await publish(db, teacher, ana, '1 second');
    await db.query(
      "update public.lab_handovers set ends_at = now() - interval '1 minute' where id = $1",
      [rows[0].id],
    );

    expect((await run(db, asUser(ana), 'select id from public.lab_handovers')).rows).toEqual([]);
    const asTeacher = await run(
      db,
      asUser(teacher),
      'select id from public.lab_handovers where id = $1',
      [rows[0].id],
    );
    expect(asTeacher.rows).toHaveLength(1);
  });

  it('o aluno não cria, não altera e não apaga acessos', async () => {
    const { teacher, ana } = await world();
    const { rows } = await publish(db, teacher, ana);
    const id = rows[0].id;

    // A tabela tem permissões para o professor; para o aluno é a segurança por linha que barra.
    await expect(run(db, asUser(ana), INSERT, [ana.id, ana.id, '1 hour'])).rejects.toThrow(
      /row-level security/,
    );
    const updated = await run(
      db,
      asUser(ana),
      "update public.lab_handovers set ends_at = now() + interval '9 days' where id = $1",
      [id],
    );
    expect(updated.affectedRows).toBe(0);
    const deleted = await run(db, asUser(ana), 'delete from public.lab_handovers where id = $1', [
      id,
    ]);
    expect(deleted.affectedRows).toBe(0);

    // O acesso continua lá, com o prazo de antes.
    const still = await db.query(
      "select ends_at < now() + interval '3 hours' as unchanged from public.lab_handovers where id = $1",
      [id],
    );
    expect(still.rows).toEqual([{ unchanged: true }]);

    // E as colunas que nem o professor muda continuam fechadas para o aluno.
    await expect(
      run(
        db,
        asUser(ana),
        "update public.lab_handovers set password = 'outra-senha-1' where id = $1",
        [id],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('um professor pendente (ainda aluno) não publica nada', async () => {
    const { ana, pending } = await world();
    await expect(run(db, asUser(pending), INSERT, [ana.id, pending.id, '1 hour'])).rejects.toThrow(
      /row-level security/,
    );
  });

  it('o professor só publica como ele mesmo e só para um aluno', async () => {
    const { teacher, other, ana } = await world();

    // em nome de outro professor
    await expect(run(db, asUser(teacher), INSERT, [ana.id, other.id, '1 hour'])).rejects.toThrow(
      /row-level security/,
    );
    // para um professor aprovado
    await expect(
      run(db, asUser(teacher), INSERT, [other.id, teacher.id, '1 hour']),
    ).rejects.toThrow(/row-level security/);
    // para quem não existe
    await expect(run(db, asUser(teacher), INSERT, [uuid(), teacher.id, '1 hour'])).rejects.toThrow(
      /row-level security|foreign key/,
    );
  });

  it('estender muda só ends_at; a senha e o resto não mudam depois de publicados', async () => {
    const { teacher, other, ana } = await world();
    const { rows } = await publish(db, teacher, ana, '1 hour');
    const id = rows[0].id;

    // qualquer professor estende
    const extended = await run(
      db,
      asUser(other),
      "update public.lab_handovers set ends_at = now() + interval '3 hours' where id = $1 returning ends_at",
      [id],
    );
    expect(extended.rows).toHaveLength(1);

    for (const column of ['password', 'student_id', 'host_address', 'windows_user']) {
      const value = column === 'student_id' ? `'${teacher.id}'` : "'outro-valor-123'";
      await expect(
        run(
          db,
          asUser(teacher),
          `update public.lab_handovers set ${column} = ${value} where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('o professor apaga o acesso (encerrar ou trocar de aluno)', async () => {
    const { teacher, ana } = await world();
    const { rows } = await publish(db, teacher, ana);
    const removed = await run(
      db,
      asUser(teacher),
      'delete from public.lab_handovers where id = $1',
      [rows[0].id],
    );
    expect(removed.affectedRows).toBe(1);
    expect((await run(db, asUser(ana), 'select id from public.lab_handovers')).rows).toEqual([]);
  });

  it('limites de tamanho e formato das colunas', async () => {
    const { teacher, ana } = await world();
    const attempt = (override) =>
      run(
        db,
        asUser(teacher),
        `insert into public.lab_handovers (student_id, created_by, reservation_id, host_id, host_name,
           host_address, windows_user, password, ends_at)
         values ($1, $2, 'r', 'h', 'PC', ${override.address ?? "'100.64.0.1'"}, 'u', ${override.password ?? "'password-ok-1'"}, now() + interval '1 hour')`,
        [ana.id, teacher.id],
      );
    await expect(attempt({ password: "'curta'" })).rejects.toThrow(/check constraint/);
    await expect(attempt({ address: "''" })).rejects.toThrow(/check constraint/);
    await expect(attempt({})).resolves.toBeTruthy();
  });
});

describe('vínculos (lab_student_links)', () => {
  const LINK = `insert into public.lab_student_links (host_id, windows_account, student_id, label, linked_by)
                values ($1, $2, $3, $4, $5)`;

  it('só professor lê, cria e desfaz vínculos', async () => {
    const { teacher, ana, joao } = await world();
    await run(db, asUser(teacher), LINK, ['host-1', 'ana', ana.id, 'Ana', teacher.id]);

    const read = await run(
      db,
      asUser(teacher),
      'select windows_account, student_id from public.lab_student_links',
    );
    expect(read.rows).toEqual([{ windows_account: 'ana', student_id: ana.id }]);

    // Nem o aluno vinculado nem outro aluno enxergam ou mexem nos vínculos.
    for (const student of [ana, joao]) {
      const seen = await run(db, asUser(student), 'select * from public.lab_student_links');
      expect(seen.rows).toEqual([]);
      await expect(
        run(db, asUser(student), LINK, ['host-9', 'joao', student.id, 'X', student.id]),
      ).rejects.toThrow(/row-level security/);
      const deleted = await run(db, asUser(student), 'delete from public.lab_student_links');
      expect(deleted.affectedRows).toBe(0);
    }
    await expect(run(db, anon, 'select * from public.lab_student_links')).rejects.toThrow(
      /permission denied/,
    );

    const removed = await run(
      db,
      asUser(teacher),
      'delete from public.lab_student_links where host_id = $1 and windows_account = $2',
      ['host-1', 'ana'],
    );
    expect(removed.affectedRows).toBe(1);
  });

  it('um aluno por conta do Windows e uma conta por aluno em cada PC', async () => {
    const { teacher, ana, joao } = await world();
    await run(db, asUser(teacher), LINK, ['host-2', 'ana', ana.id, 'Ana', teacher.id]);
    await expect(
      run(db, asUser(teacher), LINK, ['host-2', 'ana', joao.id, 'João', teacher.id]),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      run(db, asUser(teacher), LINK, ['host-2', 'ana2', ana.id, 'Ana', teacher.id]),
    ).rejects.toThrow(/duplicate key/);
    // o mesmo aluno em outro PC é outra história
    await expect(
      run(db, asUser(teacher), LINK, ['host-3', 'ana', ana.id, 'Ana', teacher.id]),
    ).resolves.toBeTruthy();
  });

  it('o professor só vincula em seu próprio nome, e a conta do Windows tem formato fixo', async () => {
    const { teacher, other, ana } = await world();
    await expect(
      run(db, asUser(teacher), LINK, ['host-4', 'ana', ana.id, 'Ana', other.id]),
    ).rejects.toThrow(/row-level security/);
    for (const account of ['Ana', 'ana maria', 'a'.repeat(21), '']) {
      await expect(
        run(db, asUser(teacher), LINK, ['host-4', account, ana.id, 'Ana', teacher.id]),
      ).rejects.toThrow(/check constraint/);
    }
  });

  it('apagar a conta do aluno leva junto os vínculos e os acessos dele', async () => {
    const { teacher, ana } = await world();
    await run(db, asUser(teacher), LINK, ['host-5', 'ana', ana.id, 'Ana', teacher.id]);
    await publish(db, teacher, ana);

    await db.query('delete from auth.users where id = $1', [ana.id]);
    const links = await db.query('select 1 from public.lab_student_links where student_id = $1', [
      ana.id,
    ]);
    const handovers = await db.query('select 1 from public.lab_handovers where student_id = $1', [
      ana.id,
    ]);
    expect(links.rows).toEqual([]);
    expect(handovers.rows).toEqual([]);
  });
});

describe('limpeza dos acessos vencidos', () => {
  it('purge_expired_handovers remove os vencidos e deixa os válidos', async () => {
    const { teacher, ana, joao } = await world();
    const expired = await publish(db, teacher, ana, '1 hour');
    await db.query(
      "update public.lab_handovers set ends_at = now() - interval '5 minutes' where id = $1",
      [expired.rows[0].id],
    );
    const valid = await publish(db, teacher, joao, '1 hour');

    const result = await db.query('select public.purge_expired_handovers() as removed');
    expect(result.rows[0].removed).toBeGreaterThanOrEqual(1);

    const left = await db.query('select id from public.lab_handovers where id = any($1::uuid[])', [
      [expired.rows[0].id, valid.rows[0].id],
    ]);
    expect(left.rows.map((row) => row.id)).toEqual([valid.rows[0].id]);
  });

  it('ninguém além do dono do banco (o pg_cron) chama a limpeza', async () => {
    const { teacher, ana } = await world();
    for (const who of [asUser(teacher), asUser(ana), anon]) {
      await expect(run(db, who, 'select public.purge_expired_handovers()')).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('a tabela de acessos está na publicação do Realtime', async () => {
    const { rows } = await db.query(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime'",
    );
    expect(rows.map((row) => row.tablename)).toContain('lab_handovers');
  });
});
