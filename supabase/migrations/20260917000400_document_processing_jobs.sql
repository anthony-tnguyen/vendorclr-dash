-- Task 8a - the async processing job queue TABLE only. This is the whole
-- mechanism that lets finalizePackage()/uploadDocumentForToken() (Task 8a)
-- return to the browser without waiting on document extraction: instead of
-- calling the extraction provider inline, they insert one row here per
-- document that needs processing and return immediately. A future
-- Edge Function - process-document-jobs, Task 8b, per this codebase's
-- established Deno/@ts-nocheck Edge Function pattern (send-renewal-reminders/
-- retry-failed-documents/resend-webhook) - is what actually claims and works
-- these rows. That worker, and the atomic-claim/bounded-retry/backoff logic
-- the top-level task checklist calls for, is explicitly NOT built by this
-- migration or this dispatch.
--
-- Handoff to Task 8b - columns deliberately NOT added here, left for that
-- migration to add:
--   attempt_count / max_attempts   - bounded retries
--   next_attempt_at                - exponential backoff scheduling
--   claimed_at / claimed_by        - atomic claim (e.g. `for update skip
--                                     locked`, or a compare-and-swap on
--                                     status + claimed_at/claimed_by)
--   last_error                     - most recent failure detail, surfaced
--                                     wherever 8b's operations visibility
--                                     lives
--   exhausted_at                   - when a job gave up for good
--
-- `status` already includes 'exhausted' as a valid value, so 8b's migration
-- does not need to widen this CHECK constraint - only add the columns that
-- explain *how* and *why* a row reached queued -> processing -> exhausted,
-- and the claim/retry logic that drives that transition atomically.

create table public.document_processing_jobs (
  id                  uuid primary key default gen_random_uuid(),
  -- Denormalised from vendor_documents (and, when set, submission_packages)
  -- for RLS/operations visibility - kept honest by
  -- assert_document_processing_job_consistency() below, same pattern as
  -- every other denormalised company_id/vendor_id pair in this schema.
  company_id          uuid not null references public.companies (id) on delete cascade,
  vendor_id           uuid not null references public.vendors (id) on delete cascade,
  target_document_id  uuid not null references public.vendor_documents (id) on delete cascade,
  -- Which package this document was part of when the job was enqueued, if
  -- any - null for the legacy single-file uploadDocumentForToken() path,
  -- which has no package. A job always targets exactly one DOCUMENT (see
  -- this file's top docblock and submissionPackages.ts's finalizePackage()/
  -- replaceDeficientDocument() for why extraction is enqueued per document,
  -- never per whole package: it lets replaceDeficientDocument() re-enqueue
  -- work for only the one document that changed).
  target_package_id   uuid references public.submission_packages (id) on delete cascade,
  -- Only one job type exists today. A text CHECK, not an enum, matching
  -- this schema's established closed-vocabulary pattern - widen the CHECK
  -- when a second job type is actually needed.
  job_type            text not null default 'extract_document'
                        check (job_type in ('extract_document')),
  status              text not null default 'queued'
                        check (status in ('queued', 'processing', 'succeeded', 'failed', 'exhausted')),
  -- '<target_document_id>:<job_type>' - see submissionPackages.ts/
  -- vendorUploadRequests.ts's enqueue call sites. Enforced unique so an
  -- enqueue is written as `insert ... on conflict (idempotency_key) do
  -- nothing`: calling finalizePackage() twice on an already-finalized
  -- package (or any other caller retrying an enqueue) can never create a
  -- second job for the same document/job-type pair, regardless of how many
  -- times the enqueueing workflow function itself runs. This is the
  -- package-level half of "retries/providers cannot create duplicate
  -- processing results" - the worker-side idempotency (a provider retrying
  -- mid-job) is Task 8b's to build on top of this.
  idempotency_key     text not null unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index document_processing_jobs_status_idx on public.document_processing_jobs (status);
create index document_processing_jobs_document_idx on public.document_processing_jobs (target_document_id);
create index document_processing_jobs_package_idx on public.document_processing_jobs (target_package_id)
  where target_package_id is not null;
create index document_processing_jobs_company_idx on public.document_processing_jobs (company_id);

create trigger document_processing_jobs_touch_updated_at
  before update on public.document_processing_jobs
  for each row execute function public.touch_updated_at();

create or replace function public.assert_document_processing_job_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  doc_company uuid;
  doc_vendor  uuid;
  pkg_company uuid;
begin
  select company_id, vendor_id into doc_company, doc_vendor
    from public.vendor_documents where id = new.target_document_id;

  if doc_company is null then
    raise exception 'target_document_id % does not exist', new.target_document_id using errcode = '23503';
  end if;

  if doc_company <> new.company_id or doc_vendor <> new.vendor_id then
    raise exception 'company_id/vendor_id do not match target document %', new.target_document_id
      using errcode = '23514';
  end if;

  if new.target_package_id is not null then
    select company_id into pkg_company
      from public.submission_packages where id = new.target_package_id;

    if pkg_company is null then
      raise exception 'target_package_id % does not exist', new.target_package_id using errcode = '23503';
    end if;

    if pkg_company <> new.company_id then
      raise exception 'company_id does not match target package %', new.target_package_id
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_document_processing_job_consistency()
  from public, anon, authenticated;

create trigger document_processing_jobs_consistency
  before insert or update on public.document_processing_jobs
  for each row execute function public.assert_document_processing_job_consistency();

-- ---------------------------------------------------------------------------
-- Row level security - staff can see their own company's queue for
-- operations visibility (the top-level task's "exhausted state visible in
-- operations" checklist item, which Task 8b's worker fulfils by writing
-- into these rows). Only the service-role client (used by
-- uploadDocumentForToken()/submissionPackages.ts after manual token
-- validation, and by the future worker) ever writes here - no authenticated
-- insert/update policy is needed or granted, matching email_outbox's
-- "no update policy for authenticated users" precedent.
-- ---------------------------------------------------------------------------

alter table public.document_processing_jobs enable row level security;

create policy document_processing_jobs_select on public.document_processing_jobs
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- audit_log - widen action to cover the new package-lifecycle events
-- submissionPackages.ts writes.
-- ---------------------------------------------------------------------------

alter table public.audit_log
  drop constraint audit_log_action_check;

alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
    'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
    'member_role_changed', 'member_removed', 'contact_request_sent',
    'submission_package_finalized', 'submission_document_replaced'
  ));
