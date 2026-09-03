-- Phase 4 / migration 18 - schedule the retry-failed-documents Edge
-- Function via pg_cron + pg_net.
--
-- SKIPPED_IN_PGLITE (see supabase/tests/harness.ts) - same reason as
-- 20260902000600_schedule_renewal_reminders.sql: pg_cron/pg_net need a real
-- background worker and real networking PGlite cannot provide, and there is
-- nothing here for db:verify to usefully check - the payload only means
-- something against the real project.
--
-- pg_cron/pg_net are already enabled (migration 11); this only adds a
-- second scheduled job. Reuses the same two Vault secrets that job already
-- established by name (project_url, service_role_key) - no new secrets to
-- create.
--
-- Hourly, not daily like the reminders job: the backoff schedule in the
-- Edge Function has a 1-hour first tier, so a daily cron would add up to
-- 23 hours of pure scheduling latency on top of every backoff delay for no
-- reason. Hourly does not mean hourly Anthropic calls per document -
-- documents_due_for_retry's own time filter still gates that; an hourly
-- cadence only affects how promptly a due retry is picked up, not how many
-- attempts a document accumulates.

select cron.schedule(
  'retry-failed-documents-hourly',
  '0 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/retry-failed-documents',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
