// Banco de teste das migrations do Supabase: um Postgres de verdade (PGlite, em memória) com o
// mínimo do que o Supabase já traz pronto — os papéis `anon` e `authenticated`, o esquema `auth` e
// `auth.uid()` — e as migrations de `supabase/migrations` aplicadas na ordem. Assim as regras de
// segurança por linha (RLS) são provadas de verdade dentro do `npm test`, sem Docker.
//
// Fica de fora a migration que só agenda a limpeza no pg_cron (`*_cron.sql`): o pg_cron só existe
// no Supabase; a função que ela chama é testada diretamente.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Os privilégios padrão são os do Supabase ANTES de 30/10/2026 (tudo em `public` concedido aos
// papéis da API): é o pior caso, e as migrations têm de revogar o que não deve ficar aberto.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );

  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub'
    )::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant execute on functions to anon, authenticated, service_role;

  create publication supabase_realtime;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('_cron.sql'))
    .sort();
}

export async function createDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const name of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }
  return db;
}

// Roda uma consulta como `who` — { id, role } — numa transação própria: o papel e o `sub` do token
// valem só ali, como numa chamada da API. `who` nulo roda como dono do banco (o painel do Supabase).
// Um erro desfaz só esta consulta.
export function run(db, who, sql, params = []) {
  return db.transaction(async (tx) => {
    if (who) {
      const claims = JSON.stringify({ sub: who.id ?? '', role: who.role });
      await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await tx.exec(`set local role ${who.role}`);
    }
    return tx.query(sql, params);
  });
}

export const asUser = (user) => ({ id: user.id, role: 'authenticated' });
export const anon = { id: '', role: 'anon' };

// Cria uma conta como o app faz: a linha em auth.users leva os metadados do cadastro e o gatilho
// cria o perfil. Devolve { id, email }.
export async function signUp(db, { email, meta = {} }) {
  const { rows } = await db.query(
    'insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id',
    [email, JSON.stringify(meta)],
  );
  return { id: rows[0].id, email };
}

// Faz de uma conta um professor, como o painel do Supabase faz com o primeiro (G20-S3).
export async function makeTeacher(db, user) {
  await db.query(
    "update public.profiles set role = 'professor', teacher_requested_at = null where id = $1",
    [user.id],
  );
  return user;
}

export async function profileOf(db, user) {
  const { rows } = await db.query('select * from public.profiles where id = $1', [user.id]);
  return rows[0];
}
