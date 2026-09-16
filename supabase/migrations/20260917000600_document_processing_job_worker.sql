-- Task 8b (Engineer A) - the columns and atomic-claim primitive Task 8a's
-- migration docblock explicitly left for this dispatch (see
-- 20260917000400_document_processing_jobs.sql's "Handoff to Task 8b" note).
-- The worker itself (process-document-jobs Edge Function) is not built by
-- this migration - only what the database side of that worker needs.

alter table public.document_processing_jobs
  add column attempt_count int not null default 0,
  add column max_attempts  int not null default 5,
  -- Due immediately by default - a freshly queued row has nothing to wait
  -- for. Only a failed attempt ever pushes this forward (see the worker's
  -- own backoff schedule, applied in JS when it marks a job 'failed').
  add column next_attempt_at timestamptz not null default now(),
  add column claimed_at timestamptz,
  -- A free-text label for whichever worker invocation currently holds this
  -- row (the Edge Function's own requestId) - operational traceability only,
  -- never used for authorization or as a lock token itself: the atomic
  -- claim already comes from `for update skip locked` in
  -- claim_document_processing_jobs() below, not from comparing this value.
  add column claimed_by text,
  add column last_error text,
  add column exhausted_at timestamptz;

comment on column public.document_processing_jobs.attempt_count is
  'Incremented each time the worker claims and attempts this job, whether the attempt succeeds, fails, or crashes mid-run.';
comment on column public.document_processing_jobs.max_attempts is
  'Bounded-retry cap. Once attempt_count reaches this without succeeding, the worker marks the row exhausted instead of scheduling another retry.';
comment on column public.document_processing_jobs.next_attempt_at is
  'A failed job is not eligible for reclaim until this time - exponential backoff, computed by the worker.';
comment on column public.document_processing_jobs.claimed_at is
  'Set by claim_document_processing_jobs() when a worker takes this row. Also used to detect a job whose worker crashed mid-run (processing, but claimed long enough ago to be stale) so it can be reclaimed rather than stuck forever.';

-- ---------------------------------------------------------------------------
-- claim_document_processing_jobs() - the atomic claim primitive.
--
-- NOT security definer, matching get_scheduled_job_run_history()/
-- get_database_size_bytes() in 20260917000200_operations_scheduled_job_functions.sql:
-- this function only ever needs to read/write document_processing_jobs
-- itself (no other schema, no elevated access beyond what the table's own
-- policies allow), and the only role ever granted EXECUTE is service_role,
-- which already bypasses RLS entirely (`bypassrls`) - there is nothing a
-- SECURITY DEFINER elevation would add here, and skipping it means this
-- function has no need for the "explicit authorization check as its own
-- first statement" a security-definer function would otherwise require.
-- Locked to service_role the same explicit revoke-from-named-roles way
-- every function in this schema is (see the "Supabase `revoke ... from
-- public` gotcha") - this is an internal worker primitive, never something
-- an authenticated dashboard user should call directly.
--
-- `for update skip locked` is what makes two overlapping invocations (a
-- cron tick plus a manual dispatch, or two cron ticks if a run takes longer
-- than the schedule interval) never claim the same row: each caller's
-- `select ... for update skip locked` only ever locks rows no other open
-- transaction currently holds, so a row already locked by a concurrent
-- claim is silently excluded rather than blocked on - see
-- supabase/tests/document-processing-job-claim.test.ts for a test proving
-- this against two overlapping claim calls.
--
-- Eligible rows are:
--   - status = 'queued'                                            (fresh work)
--   - status = 'failed' and next_attempt_at <= now()                (due retry)
--   - status = 'processing' and claimed_at < now() - stale window   (crashed
--     worker recovery - a row a previous invocation claimed but never
--     resolved, e.g. the function was killed mid-run. Without this a single
--     crash would strand that job in 'processing' forever, since nothing
--     else ever moves it back to 'queued'.)
-- Ordered oldest-created first so a long queue is worked in submission
-- order, not an unspecified one.
-- ---------------------------------------------------------------------------

create or replace function public.claim_document_processing_jobs(
  p_batch_size int default 10,
  p_claimed_by text default null,
  p_stale_processing_minutes int default 5
)
returns setof public.document_processing_jobs
language plpgsql
volatile
set search_path = public, pg_temp
as $fn$
begin
  return query
    update public.document_processing_jobs j
    set status = 'processing',
        claimed_at = now(),
        claimed_by = p_claimed_by,
        -- Counts the attempt now, at claim time, not on completion - a
        -- claimed job whose worker crashes before writing any result still
        -- consumed one of its max_attempts, exactly like a completed
        -- failure. Without this, a job that always crashes the worker
        -- (rather than cleanly failing) would be reclaimed by the stale-
        -- processing branch above forever and never reach 'exhausted'.
        attempt_count = j.attempt_count + 1
    from (
      select id
      from public.document_processing_jobs
      where status = 'queued'
         or (status = 'failed' and next_attempt_at <= now())
         or (status = 'processing'
             and claimed_at is not null
             and claimed_at < now() - (p_stale_processing_minutes || ' minutes')::interval)
      order by created_at
      limit greatest(p_batch_size, 0)
      for update skip locked
    ) due
    where j.id = due.id
    returning j.*;
end;
$fn$;

revoke execute on function public.claim_document_processing_jobs(int, text, int)
  from public, anon, authenticated;
grant execute on function public.claim_document_processing_jobs(int, text, int) to service_role;
