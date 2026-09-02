-- Phase 3 continued / migration 11 - schedule the renewal-reminder Edge
-- Function via pg_cron + pg_net.
--
-- SKIPPED_IN_PGLITE (see supabase/tests/harness.ts): pg_cron needs a real
-- background worker and pg_net needs real outbound networking, neither of
-- which a single-process WASM Postgres provides. There is nothing here for
-- db:verify to usefully check anyway - the payload is "call this URL with
-- this header," which only means something against the real project. That is
-- verified separately: get_advisors after apply, then a manual invocation of
-- the deployed function (see supabase/README.md).
--
-- The job body reads two Vault secrets by name rather than embedding a URL or
-- a key literally in this file:
--
--   project_url         - e.g. https://<ref>.supabase.co
--   service_role_key    - so the call carries a valid Authorization Bearer
--                          that satisfies the function's verify_jwt=true
--
-- Both must be created once per project with
-- `select vault.create_secret(value, name)` run directly against that
-- project (never through a migration - that would commit a live secret to
-- git). cron.schedule() only stores this command string; it is not evaluated
-- until the job actually fires, so this migration may be applied before
-- those secrets exist or before the function is deployed - nothing runs
-- until both are in place. supabase_vault is already enabled on every
-- Supabase project (confirmed via list_extensions before writing this).
--
-- 13:00 UTC was picked with no customer-facing meaning yet - just "once a
-- day, comfortably outside a typical US working night" - and can move once
-- there's a real timezone/preference story.

create extension if not exists pg_cron;

-- pg_net does NOT support `alter extension ... set schema` (confirmed by
-- trying it against the live project - Postgres rejects it directly), so the
-- schema has to be right at creation time or a later fix means drop +
-- recreate. `extensions` is where this project already keeps pgcrypto and
-- uuid-ossp, keeping pg_net out of `public` the same way get_advisors
-- expects. pg_cron needed no such placement - it installs into pg_catalog on
-- its own.
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'send-renewal-reminders-daily',
  '0 13 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/send-renewal-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
