-- Task 9a - versioned, immutable extraction storage.
--
-- Today vendor_documents.parsed_data/extraction_confidence are single
-- mutable columns, overwritten on every extraction attempt (documentExtraction.ts
-- migration 7) and again on every reprocess/retry. That loses history: once a
-- retry or a reviewer correction lands, whatever the model said the FIRST
-- time is gone. It also has no way to represent "a human corrected this" at
-- all - resolveReviewItem() (documentReview.ts) can only apply what parsed_data
-- already holds, never change it.
--
-- document_extractions is the append-only, immutable fix - one row per
-- extraction ATTEMPT (a model run, or a reviewer's manual correction),
-- never updated after insert. vendor_documents.current_extraction_id points
-- at whichever row is "the" accepted extraction right now; earlier attempts
-- stay in the table, queryable, forming the full model-vs-human audit trail
-- Task 9a's definition of done calls for.
--
-- ---------------------------------------------------------------------------
-- Why vendor_documents.parsed_data/extraction_confidence are NOT dropped
-- ---------------------------------------------------------------------------
-- Three call sites write an extraction result today: applyExtractionResult()
-- in src/workflows/vendorUploadRequests.ts (the synchronous exact-duplicate
-- path), and the two Deno Edge Functions supabase/functions/
-- process-document-jobs/index.ts and retry-failed-documents/index.ts - both
-- separate deployment targets with no shared build step across the Node/Deno
-- boundary (same reasoning as every other ported file in supabase/functions).
-- Several existing readers (getReviewQueueItem() in documentReview.ts today,
-- and anything Task 9b's evaluatePackage()/a future UI adds) read
-- vendor_documents.parsed_data directly and have no reason to know a
-- versioned table exists underneath.
--
-- Rather than porting "insert into document_extractions" a third time into
-- Deno (duplicating logic the two Edge Functions would then have to keep
-- byte-for-byte in sync with each other AND with Node, on top of the
-- extraction logic they already duplicate), this migration follows
-- email_outbox.status's own precedent (20260903000500_email_bounce_handling.sql
-- - "status is a derived summary, not the source of truth") but goes one
-- step further: record_document_extraction() below is ONE SQL function,
-- called via supabase.rpc() from all three write sites (Node and both Deno
-- functions alike), that inserts the immutable row AND refreshes the
-- vendor_documents cache columns in the same statement. No runtime has to
-- know about both tables - callers keep making one call, exactly as before,
-- just to a function instead of a direct .update(). parsed_data/
-- extraction_confidence remain real, live-updated columns; document_extractions
-- is the source of truth for history, the same relationship email_delivery_events
-- has to email_outbox.status.
--
-- ---------------------------------------------------------------------------
-- Why no "exactly one current per document" trigger
-- ---------------------------------------------------------------------------
-- "Current" is defined purely as whichever row current_extraction_id points
-- at - not a property record_document_extraction() needs to enforce across
-- other rows in the table. There is nothing here shaped like the
-- Task 4 "at least one default profile" BEFORE ROW trigger that a legitimate
-- multi-row operation could get wrongly blocked by; a plain FK pointer swap,
-- done in the same statement as the insert, is sufficient and cannot leave
-- the two out of sync (both writes are in the same function body, so either
-- both happen or - on any error - neither does, same guarantee a single
-- UPDATE always had).

create table public.document_extractions (
  id               uuid primary key default gen_random_uuid(),
  -- Denormalised from vendor_documents purely so RLS is one indexed
  -- predicate, same reasoning vendor_policies.company_id already documents.
  company_id       uuid not null references public.companies (id) on delete cascade,
  document_id      uuid not null references public.vendor_documents (id) on delete cascade,
  -- 'model' - produced by calling the extraction provider (either runtime).
  -- 'reviewer_edit' - a human correction saved from the review screen
  -- (Task 9a's edit-creates-a-revision requirement). Never updated in place;
  -- a second correction is a THIRD row, not an update to the second.
  source           text not null check (source in ('model', 'reviewer_edit')),
  -- Null for a reviewer_edit row - a human correction has no model/provider
  -- of its own to report.
  provider         text,
  model            text,
  -- Free text, not a foreign key to anything - lets the prompt/schema
  -- version be bumped (e.g. when this migration's own Task 9a field
  -- additions ship) without a schema migration of its own. Null for a
  -- reviewer_edit row, same reasoning as provider/model.
  prompt_version   text,
  attempted_at     timestamptz not null default now(),
  confidence       numeric check (confidence is null or confidence between 0 and 1),
  -- Full snapshot, not a diff - a reviewer_edit row carries the WHOLE
  -- corrected InsuranceExtraction, not just the changed field(s), so any
  -- single row can be read on its own as "what this attempt produced"
  -- without replaying history to reconstruct it.
  parsed_data      jsonb,
  error            text,
  -- Who made a reviewer_edit row what it is. Null for 'model' rows (no
  -- reviewer involved) and required for 'reviewer_edit' rows (see the CHECK
  -- below) - "edits are attributable" is Task 9a's own definition-of-done
  -- wording.
  reviewer_id      uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),

  check (
    (source = 'model' and reviewer_id is null)
    or (source = 'reviewer_edit' and reviewer_id is not null)
  )
);

create index document_extractions_document_idx on public.document_extractions (document_id, attempted_at desc);
create index document_extractions_company_idx on public.document_extractions (company_id);

-- Same integrity check every other child table in this schema has against
-- its own parent (assert_company_matches_vendor() for vendor-scoped tables,
-- assert_company_matches_email_outbox() for email_delivery_events) - here
-- against vendor_documents instead, since this table has no vendor_id of its
-- own.
create or replace function public.assert_company_matches_vendor_document()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  select company_id into owner_company from public.vendor_documents where id = new.document_id;
  if owner_company is null or owner_company != new.company_id then
    raise exception 'company_id % does not match the owning vendor_documents row''s company %',
      new.company_id, owner_company;
  end if;
  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_vendor_document() from public, anon, authenticated;

create trigger document_extractions_company_matches_document
  before insert or update on public.document_extractions
  for each row execute function public.assert_company_matches_vendor_document();

alter table public.document_extractions enable row level security;

-- Read-only for company members/staff, matching email_delivery_events'
-- shape - this is an audit trail, not something a customer edits directly
-- (edits go through record_document_extraction() on the service role, via
-- the documentReview.ts saveExtractionEdit() server function, after its own
-- assertPlatformAdmin() check - not through a direct table write any role
-- could issue).
create policy document_extractions_select on public.document_extractions
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

-- No insert/update/delete policy for authenticated/anon: every write goes
-- through record_document_extraction() below on the service role, which
-- bypasses RLS the same way every other extraction-writing path in this
-- project already does (vendor_documents itself, compliance_queue_items).

-- ---------------------------------------------------------------------------
-- vendor_documents.current_extraction_id
-- ---------------------------------------------------------------------------

alter table public.vendor_documents
  add column current_extraction_id uuid references public.document_extractions (id) on delete set null;

comment on column public.vendor_documents.current_extraction_id is
  'Points at whichever document_extractions row is the currently-accepted extraction for this document - the latest model attempt, or a later reviewer_edit that superseded it. Null until the first extraction attempt (record_document_extraction()) runs. parsed_data/extraction_confidence on this row are kept as a live cache of this row''s own parsed_data/confidence - see document_extractions'' own migration docblock.';

comment on column public.vendor_documents.parsed_data is
  'Structured extraction result validated against InsuranceExtractionSchema (src/workflows/insuranceExtractionSchema.ts). Null until processing_status reaches processed or needs_review. Since Task 9a (20260917000900), this is a denormalised cache of current_extraction_id''s own parsed_data, kept in sync by record_document_extraction() - document_extractions is the source of truth and full history; this column exists for cheap reads with no join, same relationship email_outbox.status has to email_delivery_events.';

comment on column public.vendor_documents.extraction_confidence is
  'Overall 0-1 confidence from the extraction model, mirrored from parsed_data.overall_confidence for cheap SQL filtering. Since Task 9a, kept in sync with current_extraction_id''s own confidence by record_document_extraction() - null for a reviewer_edit-sourced current extraction, since a human correction carries no model confidence score.';

-- ---------------------------------------------------------------------------
-- record_document_extraction() - the one function every write site calls
-- ---------------------------------------------------------------------------
--
-- Not security definer: this is never granted to anon/authenticated (see the
-- revoke below) and is only ever reached via the service-role client, which
-- already bypasses RLS structurally - there is no caller-privilege boundary
-- for security definer to cross here, and every established
-- "SECURITY DEFINER needs its own auth check" lesson in this codebase is
-- about a function reachable by an authenticated/anon caller. Authorization
-- for the one write path a human can trigger (a reviewer's edit) happens one
-- layer up, in documentReview.ts's saveExtractionEdit() via
-- assertPlatformAdmin(), before this function is ever called - the same
-- division of responsibility resolveReviewItem() already uses for the
-- service-role writes it makes today.
create or replace function public.record_document_extraction(
  p_document_id    uuid,
  p_company_id     uuid,
  p_source         text,
  p_provider       text,
  p_model          text,
  p_prompt_version text,
  p_confidence     numeric,
  p_parsed_data    jsonb,
  p_error          text,
  p_reviewer_id    uuid default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  new_id uuid;
begin
  if p_source not in ('model', 'reviewer_edit') then
    raise exception 'invalid extraction source %', p_source;
  end if;

  insert into public.document_extractions (
    document_id, company_id, source, provider, model, prompt_version,
    confidence, parsed_data, error, reviewer_id
  ) values (
    p_document_id, p_company_id, p_source, p_provider, p_model, p_prompt_version,
    p_confidence, p_parsed_data, p_error, p_reviewer_id
  )
  returning id into new_id;

  update public.vendor_documents
  set current_extraction_id = new_id,
      parsed_data = p_parsed_data,
      extraction_confidence = p_confidence
  where id = p_document_id;

  return new_id;
end;
$fn$;

-- Same explicit-role regrant every other function in this schema follows
-- (see apply_policy_renewal()'s own comment) - never rely on `from public`
-- alone (this project's own established gotcha).
revoke execute on function public.record_document_extraction(
  uuid, uuid, text, text, text, text, numeric, jsonb, text, uuid
) from public, anon, authenticated;
grant execute on function public.record_document_extraction(
  uuid, uuid, text, text, text, text, numeric, jsonb, text, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- apply_policy_renewal() gains primary_noncontributory
-- ---------------------------------------------------------------------------
-- vendor_policies.primary_noncontributory has existed since Phase 0
-- (20260901000200_vendor_domain.sql) but was never populated by this
-- function - extraction itself never read it either, until this migration's
-- companion change to InsuranceExtractionSchema. Same
-- create-or-replace-cannot-widen-in-place constraint as the
-- certificate_holder_on_file migration - the old signature is dropped first.
drop function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean, text, text
);

create or replace function public.apply_policy_renewal(
  p_company_id uuid,
  p_vendor_id uuid,
  p_existing_policy_id uuid,
  p_policy_type text,
  p_carrier_name text,
  p_policy_number text,
  p_effective_date date,
  p_expiration_date date,
  p_each_occurrence_limit bigint,
  p_general_aggregate_limit bigint,
  p_additional_insured boolean,
  p_waiver_of_subrogation boolean,
  p_certificate_holder_name text,
  p_certificate_holder_address text,
  p_primary_noncontributory boolean
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  new_policy_id uuid;
begin
  update public.vendor_policies
  set status = 'superseded'
  where id = p_existing_policy_id and vendor_id = p_vendor_id and status = 'active';

  insert into public.vendor_policies (
    company_id, vendor_id, policy_type, carrier_name, policy_number,
    effective_date, expiration_date, each_occurrence_limit, general_aggregate_limit,
    additional_insured, waiver_of_subrogation, certificate_holder_name,
    certificate_holder_address, primary_noncontributory, status, verification_status
  ) values (
    p_company_id, p_vendor_id, p_policy_type, p_carrier_name, p_policy_number,
    p_effective_date, p_expiration_date, p_each_occurrence_limit, p_general_aggregate_limit,
    p_additional_insured, p_waiver_of_subrogation, p_certificate_holder_name,
    p_certificate_holder_address, p_primary_noncontributory, 'active', 'verified'
  )
  returning id into new_policy_id;

  return new_policy_id;
end;
$fn$;

revoke execute on function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean, text, text, boolean
) from public, anon;
grant execute on function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean, text, text, boolean
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- audit_log - widen action to cover saveExtractionEdit()'s new event.
-- ---------------------------------------------------------------------------

alter table public.audit_log
  drop constraint audit_log_action_check;

alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
    'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
    'member_role_changed', 'member_removed', 'contact_request_sent',
    'submission_package_finalized', 'submission_document_replaced',
    'extraction_reviewer_edit'
  ));
