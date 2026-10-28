-- Supabase Security Advisor (2026-10-28), "Function Search Path Mutable": `public.ping` had no fixed
-- search_path. With an empty one every name in the function resolves explicitly; `now()` lives in
-- pg_catalog, which is always searched first, so the function keeps returning the server clock.

alter function public.ping() set search_path = '';
