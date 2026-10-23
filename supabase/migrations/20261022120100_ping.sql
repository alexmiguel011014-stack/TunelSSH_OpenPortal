-- Keep-alive (G20-K1): a free Supabase project is paused after a week without activity. The scheduled
-- workflow `.github/workflows/supabase-keepalive.yml` calls this function with the publishable key.
-- It reads nothing from the database and returns only the server clock.

create function public.ping()
returns timestamptz
language sql
stable
as $$
  select now();
$$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
