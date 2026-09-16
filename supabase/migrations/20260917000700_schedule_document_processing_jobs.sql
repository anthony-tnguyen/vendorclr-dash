-- Task 8b (Engineer A) - schedule the process-document-jobs Edge Function via
-- pg_cron + pg_net, same wiring as
-- 20260902000600_schedule_renewal_reminders.sql/
-- 20260903000400_schedule_automated_retries.sql. pg_cron/pg_net are already
-- enabled (migration 11); this only adds a third scheduled job, reusing the
-- same two Vault secrets (project_url, service_role_key) those jobs already
-- established.
--
-- Every minute, deliberately much tighter than retry-failed-documents'
-- hourly cadence: that job recovers documents whose vendor has already left
-- the upload page and is not watching for a result, so an hour of pure
-- scheduling latency on top of its own hours-scale backoff is fine. This
-- queue is the opposite case - a vendor's browser just finished uploading
-- and finalizePackage()/uploadDocumentForTokenHandler() returned
-- immediately specifically so the extraction can happen out of band; a
-- vendor waiting to see their submission "go through" within a couple of
-- minutes is a real expectation this schedule has to meet. Every minute
-- keeps the worst-case added latency on top of the worker's own
-- seconds-scale backoff (see process-document-jobs/index.ts) to well under
-- what a person would notice as "stuck."
--
-- SKIPPED_IN_PGLITE (see supabase/tests/harness.ts) - same reasoning as the
-- other two scheduled-job migrations: pg_cron/pg_net need a real background
-- worker and real networking PGlite does not provide, and the payload only
-- means something against the real project.

select cron.schedule(
  'process-document-jobs-every-minute',
  '* * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/process-document-jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
