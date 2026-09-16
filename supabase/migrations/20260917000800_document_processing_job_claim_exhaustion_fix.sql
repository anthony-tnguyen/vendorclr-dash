-- Task 8b (Engineer A) follow-up fix, found in self-review before shipping:
-- claim_document_processing_jobs()'s stale-processing (crash recovery)
-- branch reclaimed a row purely on "claimed long enough ago," with no check
-- against attempt_count/max_attempts. The worker (process-document-jobs/
-- index.ts) bounds retries in its OWN code by checking attempt_count there
-- - but that only runs for failures the worker's try/catch actually
-- observes (a bad download, a failed extraction, a thrown JS error). A
-- harder crash that kills the whole Edge Function invocation before any of
-- that code runs (an unhandled runtime fault, an out-of-memory kill, a hard
-- timeout) would never call recordJobFailure() at all - the row would just
-- sit in 'processing' until the stale window passed, then get reclaimed as
-- 'processing' again, attempt_count incremented again, forever. That is
-- exactly the unbounded-retry failure mode bounded retries exist to
-- prevent, and it was reachable without ever hitting the worker's own
-- attempt-count check.
--
-- Fix: before claiming, first sweep any stale 'processing' row that has
-- ALREADY used up its attempt budget straight to 'exhausted' - it never
-- gets a chance to be reclaimed as fresh work again. The ordinary claim
-- query's own processing-stale branch is narrowed to exclude
-- attempt_count >= max_attempts, so only a stale row that still has budget
-- left is ever reclaimed.
--
-- Same NOT SECURITY DEFINER / service_role-only reasoning as the original
-- function - see that migration's own docblock.

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
  -- Sweep first: a stale 'processing' row that already used every attempt
  -- is exhausted outright, never reclaimed as if it were fresh work.
  update public.document_processing_jobs
  set status = 'exhausted',
      exhausted_at = now(),
      last_error = coalesce(
        last_error,
        'The worker stopped responding mid-run without recording a result, and this job had already used every attempt.'
      )
  where status = 'processing'
    and claimed_at is not null
    and claimed_at < now() - (p_stale_processing_minutes || ' minutes')::interval
    and attempt_count >= max_attempts;

  return query
    update public.document_processing_jobs j
    set status = 'processing',
        claimed_at = now(),
        claimed_by = p_claimed_by,
        attempt_count = j.attempt_count + 1
    from (
      select id
      from public.document_processing_jobs
      where status = 'queued'
         or (status = 'failed' and next_attempt_at <= now())
         or (status = 'processing'
             and claimed_at is not null
             and claimed_at < now() - (p_stale_processing_minutes || ' minutes')::interval
             and attempt_count < max_attempts)
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
