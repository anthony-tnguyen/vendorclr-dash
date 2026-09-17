-- Task 10b - schedule the compliance-housekeeping Edge Function via
-- pg_cron -> pg_net, same wiring as the three existing scheduled functions
-- (reusing the project_url/service_role_key Vault secrets those already
-- established - see 20260917000700_schedule_document_processing_jobs.sql).
-- Kept as its own migration file, separate from
-- 20260917001300_compliance_case_escalation.sql's schema/functions/views,
-- so only this file needs to be in SKIPPED_IN_PGLITE (supabase/tests/harness.ts)
-- - the escalation/reopening schema and functions stay fully exercised by
-- PGlite tests, same split as 20260917000600_document_processing_job_worker.sql
-- (tested) vs. 20260917000700_schedule_document_processing_jobs.sql (skipped).
--
-- Daily, not minute/hourly: unlike process-document-jobs (a vendor waiting
-- on their browser) this is not latency-sensitive - a deficiency crossing a
-- 3-day threshold does not need minute-level precision. Runs at 13:00 UTC
-- (an off-peak hour for this project's assumed US-timezone customer base),
-- after send-renewal-reminders' own daily 09:00 UTC run so the two do not
-- compete for the same RESEND_API_KEY rate limit at the exact same instant.
--
-- SKIPPED_IN_PGLITE (see supabase/tests/harness.ts) - same reasoning as the
-- other scheduled-job migrations: pg_cron/pg_net need a real background
-- worker and real networking PGlite does not provide.

select cron.schedule(
  'compliance-housekeeping-daily',
  '0 13 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/compliance-housekeeping',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
