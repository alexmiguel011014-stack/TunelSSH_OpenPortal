-- Schedules the clean-up of expired lab hand-overs (GOALS 21) every 10 minutes with pg_cron.
-- Kept apart from the table migration because pg_cron only exists on Supabase (the test database in
-- supabase/tests/harness.js skips every `*_cron.sql`; the function itself is tested directly).
--
-- If `create extension` is refused when this runs, enable "pg_cron" once under
-- Database > Extensions in the Supabase dashboard and run `supabase db push` again.

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'purge-lab-handovers',
  '*/10 * * * *',
  $$select public.purge_expired_handovers()$$
);
