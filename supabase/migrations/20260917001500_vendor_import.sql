-- Task 11a - bulk CSV vendor/project import (import pipeline only; reporting/
-- exports/audit-history/metrics are a separate Task 11b, not built here).
--
-- CSV flow is preview -> validate -> confirm -> execute, all built in
-- src/workflows/vendorImports.ts. preview/validate are read-only (no schema
-- needed for them beyond ordinary SELECTs against projects/vendors, already
-- covered by their own existing RLS policies). This migration is the
-- EXECUTE-side write path:
--
--   vendor_import_batches  - one row per EXECUTED import, keyed
--                             (company_id, idempotency_key) so a retried
--                             submission (e.g. after a network timeout) is a
--                             no-op that returns the same stored result
--                             rather than a second import. Never written
--                             during preview/validate.
--   import_vendor_row()    - one SECURITY DEFINER call per ACCEPTED row,
--                             each call its own implicit transaction: it
--                             either fully commits that row's project/
--                             vendor/assignment writes or fully rolls back,
--                             independent of every other row. The TypeScript
--                             execute phase (executeVendorImport(),
--                             src/workflows/vendorImports.ts) loops over
--                             accepted rows calling this once per row -
--                             rejected rows never call it at all, so there is
--                             nothing to roll back for them.
--
-- Project/vendor lookup-vs-create and assignment upsert semantics are spelled
-- out on import_vendor_row() itself below.

-- ---------------------------------------------------------------------------
-- vendor_import_batches
-- ---------------------------------------------------------------------------

create table public.vendor_import_batches (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  uploaded_by     uuid not null references auth.users (id),
  total_rows      int not null check (total_rows >= 0),
  accepted_rows   int not null check (accepted_rows >= 0),
  rejected_rows   int not null check (rejected_rows >= 0),
  -- Per-row outcome: row number, accepted/rejected, created/matched project
  -- id + vendor id + assignment id (and whether each was newly created or
  -- looked-up) or the rejection reason(s), plus the request-dispatch outcome
  -- when the row asked for one. Exact shape owned by the TypeScript layer
  -- (RowResult in src/workflows/vendorImports.ts), not this schema - a jsonb
  -- column deliberately, since this is a snapshot of "what executeVendorImport
  -- returned", not a normalized table of its own.
  row_results     jsonb not null,
  created_at      timestamptz not null default now(),
  -- THE idempotency mechanism: a rerun with the same (company_id,
  -- idempotency_key) is caught by executeVendorImport() before any writes
  -- happen and short-circuits to returning this existing row's row_results.
  unique (company_id, idempotency_key)
);

create index vendor_import_batches_company_id_idx on public.vendor_import_batches (company_id);

-- Same "omit uploaded_by and it just works" ergonomics as audit_log.actor_id
-- (set_audit_log_actor(), 20260902000900_audit_log.sql) - a plain column
-- default of auth.uid() cannot do this because `authenticated` has no USAGE
-- on schema auth in this project; a BEFORE INSERT trigger stays inside the
-- SECURITY DEFINER boundary every other direct auth.uid() read in this
-- schema already goes through.
create or replace function public.set_vendor_import_batch_uploader()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.uploaded_by is null then
    new.uploaded_by := auth.uid();
  end if;
  return new;
end;
$fn$;

revoke execute on function public.set_vendor_import_batch_uploader() from public, anon, authenticated;

create trigger vendor_import_batches_set_uploader
  before insert on public.vendor_import_batches
  for each row execute function public.set_vendor_import_batch_uploader();

alter table public.vendor_import_batches enable row level security;

-- Select-only for company members - no direct client write policy. The only
-- write path is import_vendor_row()'s caller (executeVendorImport()) doing
-- an ordinary insert on the request-scoped client, which IS subject to RLS;
-- rather than add an insert policy scoped to can_write_company() (which
-- would work but widens who can write this table to match every other write
-- role), the batch summary row is written by the same signed-in company
-- member the import itself runs as, so vendor_import_batches_insert below
-- mirrors vendor_upload_requests' shape: any authenticated company member
-- who can write to the company may record an import they just ran.
create policy vendor_import_batches_select on public.vendor_import_batches
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy vendor_import_batches_insert on public.vendor_import_batches
  for insert to authenticated
  with check (public.can_write_company(company_id));

-- ---------------------------------------------------------------------------
-- import_vendor_row() - one accepted CSV row's writes, atomically.
-- ---------------------------------------------------------------------------
--
-- Explicit authorization check first (this project's established
-- current_company_ids()/is_platform_admin() + generic "not authorized"
-- pattern - see apply_evaluation_result(), 20260917001200_compliance_cases.sql).
--
-- Project create-or-lookup: matched by (company_id, btrim(name)) - projects
-- has `unique (company_id, name)` (20260916000300_construction_core_expand.sql)
-- so an exact-after-trim match is the natural key. certificate_holder_name/
-- _address are only ever SET on a freshly-inserted project row - an existing
-- project's certificate holder is never overwritten by an import, even if the
-- CSV row supplies a different value or leaves it blank. Preserves the row's
-- own casing on insert (btrim only, never lower()); the normalized
-- comparison is for matching, not storage.
--
-- Vendor create-or-lookup: vendors has NO unique constraint on name/email at
-- the DB level (checked - just company_id/name/trade/... with no dedup
-- constraint), so "detect normalized company/vendor/email duplicates" (the
-- plan's own wording) is implemented as an explicit lookup here: an existing
-- vendor in this company matching EITHER normalized (trim+lower) name OR
-- normalized non-empty contact_email is reused, never overwritten (trade/
-- contract_value/risk_tier/contact info all stay exactly what they already
-- were). No match -> insert a new vendor row with the row's own data.
--
-- Assignment create: project_vendor_assignments has `unique (project_id,
-- vendor_id)`. An assignment that already exists for this exact pair is not
-- an error - the row is still a success, just a no-op on the assignment
-- specifically, so a re-run of the same CSV (or two rows naming the same
-- vendor for the same project) never fails on this step. trade_code/
-- risk_classification reuse the exact same CHECK vocabularies as
-- vendors.trade/vendors.risk_tier (the migration 20 comment on
-- project_vendor_assignments.trade_code already notes these two CHECK sets
-- must agree - this function introduces no third vocabulary).
--
-- Returns the resolved project_id/vendor_id/assignment_id plus whether each
-- was newly created (vs. looked-up) - via OUT parameters, so a single RPC
-- call gets everything the TypeScript caller needs for both dispatch
-- decisions and the row_results summary, with no second round-trip.
create or replace function public.import_vendor_row(
  p_company_id                  uuid,
  p_project_name                text,
  p_certificate_holder_name     text,
  p_certificate_holder_address  text,
  p_vendor_name                 text,
  p_trade                       text,
  p_contact_name                text,
  p_contact_email               text,
  p_risk_tier                   text,
  p_contract_value              bigint,
  out project_id                uuid,
  out project_created           boolean,
  out vendor_id                 uuid,
  out vendor_created             boolean,
  out assignment_id             uuid,
  out assignment_created        boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_project_name  text := btrim(p_project_name);
  v_vendor_name   text := btrim(p_vendor_name);
  v_norm_email    text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  -- Local working variables, not the OUT parameters directly: several of
  -- these share a bare name with a column on the table being queried
  -- (project_id/vendor_id), which would make plpgsql's default
  -- variable-over-column resolution silently shadow the column reference in
  -- a WHERE clause. Using v_-prefixed locals throughout the body and only
  -- assigning to the OUT parameters at the very end avoids that ambiguity
  -- entirely rather than relying on plpgsql.variable_conflict configuration.
  v_project_id         uuid;
  v_project_created    boolean;
  v_vendor_id          uuid;
  v_vendor_created     boolean;
  v_assignment_id      uuid;
  v_assignment_created boolean;
begin
  if not (
    p_company_id in (select public.current_company_ids())
    or public.is_platform_admin()
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if length(v_project_name) = 0 then
    raise exception 'project name is required' using errcode = '22023';
  end if;
  if length(v_vendor_name) = 0 then
    raise exception 'vendor name is required' using errcode = '22023';
  end if;

  -- Project: lookup by normalized (trimmed) name first, matching
  -- projects' own `unique (company_id, name)` natural key.
  select p.id into v_project_id
  from public.projects p
  where p.company_id = p_company_id and btrim(p.name) = v_project_name;

  if found then
    v_project_created := false;
  else
    insert into public.projects (
      company_id, name, certificate_holder_name, certificate_holder_address
    ) values (
      p_company_id, v_project_name,
      coalesce(btrim(p_certificate_holder_name), ''),
      coalesce(btrim(p_certificate_holder_address), '')
    )
    returning id into v_project_id;
    v_project_created := true;
  end if;

  -- Vendor: lookup by normalized name OR normalized non-empty email -
  -- either match means "this is the same vendor", so neither branch
  -- overwrites the existing row's other fields.
  select v.id into v_vendor_id
  from public.vendors v
  where v.company_id = p_company_id
    and (
      lower(btrim(v.name)) = lower(v_vendor_name)
      or (v_norm_email is not null and lower(btrim(v.contact_email)) = v_norm_email)
    )
  order by v.created_at asc
  limit 1;

  if found then
    v_vendor_created := false;
  else
    insert into public.vendors (
      company_id, name, trade, contact_name, contact_email, risk_tier, contract_value
    ) values (
      p_company_id, v_vendor_name,
      coalesce(p_trade, 'Structural Steel'),
      coalesce(btrim(p_contact_name), ''),
      coalesce(btrim(p_contact_email), ''),
      coalesce(p_risk_tier, 'moderate'),
      coalesce(p_contract_value, 0)
    )
    returning id into v_vendor_id;
    v_vendor_created := true;
  end if;

  -- Assignment: an existing (project, vendor) pair is a success no-op, not
  -- an error - re-running the same CSV, or two rows naming the same vendor
  -- for the same project, must not fail here.
  select a.id into v_assignment_id
  from public.project_vendor_assignments a
  where a.project_id = v_project_id and a.vendor_id = v_vendor_id;

  if found then
    v_assignment_created := false;
  else
    insert into public.project_vendor_assignments (
      company_id, project_id, vendor_id, contract_value, trade_code, risk_classification
    ) values (
      p_company_id, v_project_id, v_vendor_id, p_contract_value, p_trade, p_risk_tier
    )
    returning id into v_assignment_id;
    v_assignment_created := true;
  end if;

  project_id := v_project_id;
  project_created := v_project_created;
  vendor_id := v_vendor_id;
  vendor_created := v_vendor_created;
  assignment_id := v_assignment_id;
  assignment_created := v_assignment_created;

  return;
end;
$fn$;

-- Same established gotcha as every SECURITY DEFINER function in this
-- project: Supabase grants EXECUTE to anon/authenticated directly at
-- function-creation time, which a bare "revoke ... from public" never
-- touches. Revoke from all three named roles, then grant back explicitly
-- only to authenticated - this is meant to be called directly by a
-- signed-in company member (executeVendorImport()), gated by its own
-- current_company_ids()/is_platform_admin() check above, not by RLS.
revoke execute on function public.import_vendor_row(
  uuid, text, text, text, text, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.import_vendor_row(
  uuid, text, text, text, text, text, text, text, text, bigint
) to authenticated;

-- ---------------------------------------------------------------------------
-- audit_log - widen action/target_type for the batch-level import record
-- executeVendorImport() writes after a successful (non-idempotent-replay) run.
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
    'extraction_reviewer_edit', 'compliance_exception_approved', 'compliance_exception_expired',
    'vendor_import_executed'
  ));

alter table public.audit_log
  drop constraint audit_log_target_type_check;

alter table public.audit_log
  add constraint audit_log_target_type_check
  check (target_type in (
    'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
    'company_member', 'company_invitation', 'compliance_deficiency', 'vendor_import_batch'
  ));
