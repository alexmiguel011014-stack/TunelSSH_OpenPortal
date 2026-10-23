-- OpenPortal accounts (GOALS 20): one profile per sign-up, a role (aluno or professor) that only a
-- teacher can grant, and row-level security as the boundary for everything stored here.
--
-- Rules this file enforces:
--   * every sign-up becomes an `aluno`, whatever the client sends; asking to be a teacher only records
--     `teacher_requested_at`;
--   * only `approve_teacher()` / `refuse_teacher()`, run by a teacher, change a request;
--   * a student reads only their own row, a teacher reads every row, nobody but the owner edits a name;
--   * nothing is granted to `anon`.
-- New tables in `public` are not exposed to the Data API without explicit grants (Supabase, since
-- 2026-05-30 for new projects and 2026-10-30 for existing ones), so every grant is written out here.

create type public.app_role as enum ('aluno', 'professor');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null check (char_length(full_name) between 1 and 80),
  role public.app_role not null default 'aluno',
  teacher_requested_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  -- A pending request belongs to a student: promoting someone without clearing it is refused.
  constraint profiles_request_only_for_students
    check (teacher_requested_at is null or role = 'aluno')
);

create index profiles_pending_requests_idx
  on public.profiles (teacher_requested_at)
  where teacher_requested_at is not null;

-- Is the caller an approved teacher? `security definer` so the policies below can ask without
-- recursing into the table's own row-level security.
create function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'professor'
  );
$$;

-- Creates the profile when an account is created. The role is NEVER read from the metadata the
-- client sent; `wants_teacher` only starts a request. The name is cleaned and cut to the column limit
-- so a hostile sign-up cannot make the insert fail or smuggle control characters in.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text := left(
    btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'full_name', ''), '[[:cntrl:]]', '', 'g')),
    80
  );
  wants_teacher boolean := coalesce(new.raw_user_meta_data ->> 'wants_teacher', 'false') = 'true';
begin
  if requested_name = '' then
    requested_name := left(btrim(split_part(coalesce(new.email, ''), '@', 1)), 80);
  end if;
  if requested_name = '' then
    requested_name := 'Sem nome';
  end if;

  insert into public.profiles (id, email, full_name, role, teacher_requested_at)
  values (
    new.id,
    coalesce(new.email, ''),
    requested_name,
    'aluno',
    case when wants_teacher then now() end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.approve_teacher(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_teacher() then
    raise exception 'only a teacher can decide a request' using errcode = '42501';
  end if;

  update public.profiles
     set role = 'professor', approved_by = auth.uid(), teacher_requested_at = null
   where id = target and role = 'aluno' and teacher_requested_at is not null;

  if not found then
    raise exception 'no pending teacher request for this account' using errcode = 'P0002';
  end if;
end;
$$;

create function public.refuse_teacher(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_teacher() then
    raise exception 'only a teacher can decide a request' using errcode = '42501';
  end if;

  update public.profiles
     set teacher_requested_at = null
   where id = target and role = 'aluno' and teacher_requested_at is not null;

  if not found then
    raise exception 'no pending teacher request for this account' using errcode = 'P0002';
  end if;
end;
$$;

alter table public.profiles enable row level security;

create policy "profiles: read own row" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles: teachers read every row" on public.profiles
  for select to authenticated
  using ((select public.is_teacher()));

create policy "profiles: update own row" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Grants: start from nothing, then give back exactly what the app uses. The column-level UPDATE is
-- what keeps `role` and the request columns out of a student's hands.
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (full_name) on table public.profiles to authenticated;

revoke all on function public.is_teacher() from public, anon, authenticated;
grant execute on function public.is_teacher() to authenticated;

revoke all on function public.handle_new_user() from public, anon, authenticated;

revoke all on function public.approve_teacher(uuid) from public, anon, authenticated;
grant execute on function public.approve_teacher(uuid) to authenticated;

revoke all on function public.refuse_teacher(uuid) from public, anon, authenticated;
grant execute on function public.refuse_teacher(uuid) to authenticated;
