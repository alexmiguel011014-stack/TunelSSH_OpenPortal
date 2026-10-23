-- "Meu acesso" (GOALS 21): the teacher's app publishes the lab access it just handed out, and the
-- student's app reads it. Two tables:
--
--   lab_student_links  which app account (a student) is which Windows account on which lab PC;
--   lab_handovers      the access itself: PC, address, Windows user, PASSWORD, start-by and end times.
--
-- The Windows password exists here only while the access is valid: ending or handing over deletes the
-- row, `purge_expired_handovers()` (scheduled in the next migration) removes whatever expired, and a
-- student's policy stops showing a row the moment its `ends_at` passes. The GOALS 19 journal, not this
-- table, is the audit trail. Rows are written by teachers only; the lab PC itself is still controlled
-- by `tailscale whois` and the PC's managers (GOALS 16), never by anything in this schema.

create table public.lab_student_links (
  host_id text not null check (char_length(host_id) between 1 and 64),
  windows_account text not null check (windows_account ~ '^[a-z0-9_-]{1,20}$'),
  student_id uuid not null references public.profiles (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 40),
  linked_by uuid references public.profiles (id) on delete set null,
  linked_at timestamptz not null default now(),
  primary key (host_id, windows_account),
  unique (host_id, student_id)
);

create table public.lab_handovers (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  reservation_id text not null check (char_length(reservation_id) between 1 and 64),
  host_id text not null check (char_length(host_id) between 1 and 64),
  host_name text not null check (char_length(host_name) between 1 and 80),
  host_address text not null check (char_length(host_address) between 1 and 253),
  windows_user text not null check (char_length(windows_user) between 1 and 80),
  password text not null check (char_length(password) between 8 and 64),
  start_by timestamptz,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index lab_handovers_student_idx on public.lab_handovers (student_id, ends_at);
create index lab_handovers_host_idx on public.lab_handovers (host_id);
create index lab_handovers_ends_at_idx on public.lab_handovers (ends_at);

alter table public.lab_student_links enable row level security;
alter table public.lab_handovers enable row level security;

-- Links: teachers only, in every direction.
create policy "links: teachers read" on public.lab_student_links
  for select to authenticated
  using ((select public.is_teacher()));

create policy "links: teachers insert" on public.lab_student_links
  for insert to authenticated
  with check ((select public.is_teacher()) and linked_by = (select auth.uid()));

create policy "links: teachers delete" on public.lab_student_links
  for delete to authenticated
  using ((select public.is_teacher()));

-- Hand-overs: a student reads their own row while it is still valid; teachers read all of them.
create policy "handovers: students read their own active access" on public.lab_handovers
  for select to authenticated
  using (student_id = (select auth.uid()) and ends_at > now());

create policy "handovers: teachers read" on public.lab_handovers
  for select to authenticated
  using ((select public.is_teacher()));

-- A teacher publishes as themselves, and only for someone who is a student (`aluno`: a pending
-- teacher is still an `aluno`; an approved teacher is not a valid target).
create policy "handovers: teachers insert" on public.lab_handovers
  for insert to authenticated
  with check (
    (select public.is_teacher())
    and created_by = (select auth.uid())
    and exists (
      select 1 from public.profiles student
      where student.id = student_id and student.role = 'aluno'
    )
  );

create policy "handovers: teachers extend" on public.lab_handovers
  for update to authenticated
  using ((select public.is_teacher()))
  with check ((select public.is_teacher()));

create policy "handovers: teachers delete" on public.lab_handovers
  for delete to authenticated
  using ((select public.is_teacher()));

revoke all on table public.lab_student_links from anon, authenticated;
grant select, insert, delete on table public.lab_student_links to authenticated;

-- Only `ends_at` can change after the fact (an extension); the password never does.
revoke all on table public.lab_handovers from anon, authenticated;
grant select, insert, delete on table public.lab_handovers to authenticated;
grant update (ends_at) on table public.lab_handovers to authenticated;

-- Removes every access that has expired. Run by pg_cron (next migration); nobody else may call it.
create function public.purge_expired_handovers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.lab_handovers where ends_at <= now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_expired_handovers() from public, anon, authenticated;

-- The student's app re-reads on any change of this table (Realtime respects the policies above).
alter publication supabase_realtime add table public.lab_handovers;
