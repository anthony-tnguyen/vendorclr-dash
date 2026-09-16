-- Task 2 (Engineer A) continued - two narrow public-schema wrapper functions
-- so getOperationalFailures() (src/server/operations.ts) can read pg_cron's
-- run history and the database's on-disk size through this app's ordinary
-- Supabase client, which only ever speaks to PostgREST.
--
-- Why a wrapper function rather than querying cron.job_run_details or
-- calling pg_database_size() directly from supabase-js: PostgREST only
-- serves REST/RPC resources for schemas explicitly exposed to it (`public`,
-- by this project's default configuration) - `cron` is not one, and neither
-- is `pg_catalog` (where pg_database_size lives). The read grants from
-- 20260917000100_operations_cron_grants.sql make service_role able to read
-- cron.job/cron.job_run_details at the SQL level, but that alone does not
-- make them reachable through this app's Supabase client - only a
-- `public`-schema function, called via `.rpc()`, does. This is the standard
-- Supabase pattern for surfacing another schema's data through PostgREST
-- without changing the project's schema-exposure configuration.
--
-- Neither function is SECURITY DEFINER: each runs as whatever role calls it,
-- relying on the read grants already in place (service_role for cron; every
-- role has EXECUTE on pg_database_size() by Postgres default) rather than an
-- elevated function owner - the narrower of the two options. Both are then
-- locked to service_role only via the same revoke-from-named-roles pattern
-- migration 1 fixed everywhere else in this schema (see the "Supabase
-- `revoke ... from public` gotcha" - PUBLIC and the anon/authenticated roles
-- are separate grants; only an explicit `revoke ... from anon, authenticated`
-- removes the default-privileges EXECUTE grant Supabase applies at function-
-- creation time). getOperationalFailures() runs both only on the
-- service-role client, after assertPlatformAdmin() has already independently
-- confirmed the caller is VendorClr staff via RLS/auth.uid() - see that
-- function's own docblock in vendorUploadRequests.ts.
--
-- SKIPPED_IN_PGLITE (see supabase/tests/harness.ts): both reference the
-- `cron` schema (job_run_history) or are otherwise only meaningful against
-- the real project (database size) - same reasoning as
-- 20260917000100_operations_cron_grants.sql.

create or replace function public.get_scheduled_job_run_history()
returns table (job_name text, status text, start_time timestamptz)
language sql
stable
set search_path = public, cron, pg_temp
as $fn$
  select j.jobname, r.status, r.start_time
  from cron.job_run_details r
  join cron.job j on j.jobid = r.jobid
  order by r.start_time desc
  limit 200;
$fn$;

revoke execute on function public.get_scheduled_job_run_history() from public, anon, authenticated;
grant execute on function public.get_scheduled_job_run_history() to service_role;

create or replace function public.get_database_size_bytes()
returns bigint
language sql
stable
set search_path = pg_catalog, pg_temp
as $fn$
  select pg_database_size(current_database());
$fn$;

revoke execute on function public.get_database_size_bytes() from public, anon, authenticated;
grant execute on function public.get_database_size_bytes() to service_role;
