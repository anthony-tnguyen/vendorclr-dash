-- Task 10a - deficiency cases, the correction loop, and controlled exceptions
-- (schema + core domain logic half only; the escalation-reminder cron and the
-- exception-expiry-reopening sweep are Task 10b, not built here).
--
-- src/domain/compliance/evaluatePackage.ts (Task 9b) already produces an
-- EvaluationResult - a per-requirement tri-state finding (verified/deficient/
-- unknown/not_applicable) - but never persists it anywhere; every call
-- recomputes from scratch and nothing durable tracks "this vendor still owes
-- us a fix for requirement X" across resubmissions. This migration is the
-- durable half: one case per (assignment, upload_request) cycle, one
-- immutable evaluation-run row per evaluatePackage() call ever applied, and
-- one live, resubmission-updated-in-place deficiency row per requirement_key
-- that has ever been non-verified/non-not_applicable.
--
-- Exactly the same immutable-history-plus-live-cache shape Task 9a already
-- established for document_extractions/vendor_documents.current_extraction_id
-- (see 20260917000900_versioned_extractions.sql's own docblock):
--
--   compliance_evaluation_runs  <-> document_extractions   (append-only, immutable)
--   compliance_deficiencies     <-> vendor_documents        (live cache, mutated in place)
--
-- compliance_cases deliberately has NO status column: "is this case open" is
-- a derived fact (does it have >=1 compliance_deficiencies row with
-- status='open'), not a column that could silently drift from the
-- deficiencies underneath it - same reasoning email_outbox.status/
-- document_extractions apply elsewhere in this schema ("status is a derived
-- summary, not the source of truth", where a derived summary is even kept at
-- all).
--
-- The single most load-bearing invariant here: once a compliance_deficiencies
-- row is 'waived' via approve_compliance_exception(), a later
-- apply_evaluation_result() call must NEVER touch it again - not to reopen it
-- on a fresh regression, not to "resolve" it out from under itself on a fresh
-- pass. An approved exception freezes the row until Task 10b's future
-- expiry-reopening sweep (not built here) explicitly reopens it. See both
-- functions' own comments below and supabase/tests/compliance-cases.test.ts's
-- "waiver freeze" tests.

-- ---------------------------------------------------------------------------
-- compliance_cases
-- ---------------------------------------------------------------------------

create table public.compliance_cases (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  -- Denormalised from project_vendor_assignments, same one-indexed-predicate
  -- RLS reasoning as every other child table in this schema. Kept honest by
  -- assert_company_matches_compliance_case_assignment() below.
  vendor_id          uuid not null references public.vendors (id) on delete cascade,
  assignment_id      uuid not null references public.project_vendor_assignments (id) on delete cascade,
  upload_request_id  uuid not null references public.vendor_upload_requests (id) on delete cascade,
  opened_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A case is get-or-create keyed by this pair, never duplicated -
  -- apply_evaluation_result() below upserts on exactly this constraint.
  unique (assignment_id, upload_request_id)
);

create index compliance_cases_company_idx on public.compliance_cases (company_id);
create index compliance_cases_vendor_idx on public.compliance_cases (vendor_id);
create index compliance_cases_assignment_idx on public.compliance_cases (assignment_id);

create trigger compliance_cases_touch_updated_at
  before update on public.compliance_cases
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- compliance_evaluation_runs - immutable, append-only
-- ---------------------------------------------------------------------------

create table public.compliance_evaluation_runs (
  id                     uuid primary key default gen_random_uuid(),
  -- Denormalised from compliance_cases, same reasoning as above. Kept
  -- honest by assert_company_matches_compliance_case() below.
  company_id             uuid not null references public.companies (id) on delete cascade,
  case_id                uuid not null references public.compliance_cases (id) on delete cascade,
  package_id             uuid not null references public.submission_packages (id) on delete cascade,
  -- From the caller's own EvaluationResult.evaluatedAt, not now() - this
  -- preserves exactly what evaluatePackage() stamped at evaluation time,
  -- not when apply_evaluation_result() happened to be called with it.
  evaluated_at           timestamptz not null,
  -- The full ResolvedRequirement[] / Finding[] the run produced - a
  -- snapshot, not a diff, so any single row can be read on its own as
  -- "what this run evaluated and found" without replaying history.
  requirements_snapshot  jsonb not null,
  findings_snapshot      jsonb not null,
  created_at             timestamptz not null default now()
  -- No updated_at, no update trigger: this table is never updated after
  -- insert, same as document_extractions.
);

create index compliance_evaluation_runs_case_idx on public.compliance_evaluation_runs (case_id, created_at desc);
create index compliance_evaluation_runs_company_idx on public.compliance_evaluation_runs (company_id);
create index compliance_evaluation_runs_package_idx on public.compliance_evaluation_runs (package_id);

-- ---------------------------------------------------------------------------
-- compliance_deficiencies - one row per (case, requirement_key), live cache
-- ---------------------------------------------------------------------------

create table public.compliance_deficiencies (
  id                            uuid primary key default gen_random_uuid(),
  company_id                    uuid not null references public.companies (id) on delete cascade,
  case_id                       uuid not null references public.compliance_cases (id) on delete cascade,
  requirement_key               text not null,
  status                        text not null default 'open' check (status in ('open', 'resolved', 'waived')),
  -- Denormalised from the matching ResolvedRequirement in
  -- requirements_snapshot at the time this row was written/last updated -
  -- lets generateCorrectionInstruction() (src/domain/compliance/cases.ts)
  -- template off this row alone, without a join back through
  -- compliance_evaluation_runs.requirements_snapshot. Nullable: a
  -- requirement_key that is absent from a later run's requirements_snapshot
  -- entirely (a profile/rule change) has nothing to denormalise, but its
  -- deficiency row (and history) must still be able to exist.
  kind                          text check (kind in ('document', 'limit', 'endorsement', 'certificate_holder')),
  policy_type                   text check (policy_type in (
                                  'general_liability', 'workers_compensation', 'commercial_auto',
                                  'umbrella', 'professional_liability', 'pollution_liability',
                                  'builders_risk'
                                )),
  -- expected/observed/explanation/evidence_document_ids always reflect the
  -- LATEST run that touched this row (last_evaluation_run_id) - the full,
  -- immutable per-run history lives in compliance_evaluation_runs.
  -- findings_snapshot, this row is a live cache of it, exactly mirroring
  -- vendor_documents.parsed_data being a live cache of
  -- document_extractions.parsed_data.
  expected                      jsonb not null,
  observed                      jsonb,
  explanation                   text not null,
  evidence_document_ids         uuid[] not null default '{}',
  first_evaluation_run_id       uuid not null references public.compliance_evaluation_runs (id),
  last_evaluation_run_id        uuid not null references public.compliance_evaluation_runs (id),
  resolved_at                   timestamptz,
  resolved_by_evaluation_run_id uuid references public.compliance_evaluation_runs (id),
  -- Set by approve_compliance_exception() below when status='waived'. FK
  -- added by a trailing ALTER once compliance_exceptions exists - cannot be
  -- forward-referenced in this CREATE TABLE.
  waived_via_exception_id       uuid,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- This is what makes "resubmissions remain on the same case... close
  -- deficiencies independently and retain history" true: the SAME row is
  -- updated across resubmissions rather than a new one inserted each time.
  unique (case_id, requirement_key)
);

create index compliance_deficiencies_company_idx on public.compliance_deficiencies (company_id);
create index compliance_deficiencies_case_idx on public.compliance_deficiencies (case_id);
-- Powers "list open deficiencies for a case/company" reads a future UI needs.
create index compliance_deficiencies_open_idx on public.compliance_deficiencies (case_id) where status = 'open';

create trigger compliance_deficiencies_touch_updated_at
  before update on public.compliance_deficiencies
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- compliance_exceptions - one row per approved, time-bounded waiver
-- ---------------------------------------------------------------------------

create table public.compliance_exceptions (
  id                          uuid primary key default gen_random_uuid(),
  -- Denormalised from compliance_deficiencies, same reasoning as above.
  -- Kept honest by assert_company_matches_compliance_deficiency() below.
  company_id                  uuid not null references public.companies (id) on delete cascade,
  deficiency_id                uuid not null references public.compliance_deficiencies (id) on delete cascade,
  reason                      text not null check (length(btrim(reason)) > 0),
  effective_on                date not null,
  expires_on                  date not null check (expires_on > effective_on),
  supporting_document_id      uuid references public.vendor_documents (id),
  vendor_visible               boolean not null default false,
  -- The plan's own bullet explicitly requires "remaining-risk
  -- acknowledgement" as part of exception approval - a real required
  -- boolean column, not implied by the row merely existing (which would let
  -- a caller approve an exception without ever having been forced to assert
  -- it). ComplianceExceptionInput's TS shape in the plan excerpt omits this
  -- field; see approve_compliance_exception()'s own comment for why that is
  -- treated as an earlier-sketch gap, not license to drop the requirement.
  remaining_risk_acknowledged boolean not null,
  approved_by                 uuid not null references auth.users (id),
  approved_at                 timestamptz not null default now(),
  -- Left null here on purpose - Task 10b's future expiry-reopening sweep
  -- (not built in this task) sets this when it reopens the deficiency.
  reopened_at                  timestamptz,
  created_at                   timestamptz not null default now()
);

create index compliance_exceptions_deficiency_idx on public.compliance_exceptions (deficiency_id);
create index compliance_exceptions_company_idx on public.compliance_exceptions (company_id);
-- Powers Task 10b's future expiry sweep ("find approved, not-yet-reopened
-- exceptions past their expires_on") - safe/cheap to add now even though
-- nothing in this task queries it yet, since it is a trivial index on
-- already-required columns, not new surface area.
create index compliance_exceptions_expiring_idx on public.compliance_exceptions (expires_on) where reopened_at is null;

alter table public.compliance_deficiencies
  add constraint compliance_deficiencies_waived_via_exception_id_fkey
  foreign key (waived_via_exception_id) references public.compliance_exceptions (id);

-- ---------------------------------------------------------------------------
-- Integrity: child company_id (and, for compliance_cases, vendor_id) must
-- equal the real parent's own - same problem/fix as
-- assert_company_matches_vendor() (migration 2)/assert_company_matches_
-- project() (migration 20)/assert_company_matches_upload_request()
-- (migration 24): an RLS WITH CHECK on company_id and a plain FK on the
-- parent id can each individually pass while still letting a caller who can
-- write to company A attach a row claiming company_id = A to a case/run/
-- deficiency/exception actually owned by company B.
-- ---------------------------------------------------------------------------

create or replace function public.assert_company_matches_compliance_case_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  a_company uuid;
  a_vendor  uuid;
begin
  select company_id, vendor_id into a_company, a_vendor
  from public.project_vendor_assignments where id = new.assignment_id;

  if a_company is null then
    raise exception 'assignment_id % does not exist', new.assignment_id using errcode = '23503';
  end if;

  if a_company <> new.company_id or a_vendor <> new.vendor_id then
    raise exception 'company_id/vendor_id do not match project_vendor_assignments %', new.assignment_id
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_compliance_case_assignment() from public, anon, authenticated;

create trigger compliance_cases_company_matches_assignment
  before insert or update on public.compliance_cases
  for each row execute function public.assert_company_matches_compliance_case_assignment();

-- Reuses migration 24's assert_company_matches_upload_request() as-is -
-- compliance_cases has the exact same (company_id, vendor_id,
-- upload_request_id) column shape upload_request_checklist_items/
-- submission_packages already check against.
create trigger compliance_cases_company_matches_upload_request
  before insert or update on public.compliance_cases
  for each row execute function public.assert_company_matches_upload_request();

create or replace function public.assert_company_matches_compliance_case()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  select company_id into owner_company from public.compliance_cases where id = new.case_id;

  if owner_company is null then
    raise exception 'case_id % does not exist', new.case_id using errcode = '23503';
  end if;

  if owner_company <> new.company_id then
    raise exception 'company_id % does not match owning compliance case %''s company %',
      new.company_id, new.case_id, owner_company using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_compliance_case() from public, anon, authenticated;

create trigger compliance_evaluation_runs_company_matches_case
  before insert or update on public.compliance_evaluation_runs
  for each row execute function public.assert_company_matches_compliance_case();

create trigger compliance_deficiencies_company_matches_case
  before insert or update on public.compliance_deficiencies
  for each row execute function public.assert_company_matches_compliance_case();

create or replace function public.assert_company_matches_compliance_deficiency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  select company_id into owner_company
  from public.compliance_deficiencies where id = new.deficiency_id;

  if owner_company is null then
    raise exception 'deficiency_id % does not exist', new.deficiency_id using errcode = '23503';
  end if;

  if owner_company <> new.company_id then
    raise exception 'company_id % does not match owning compliance deficiency %''s company %',
      new.company_id, new.deficiency_id, owner_company using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_compliance_deficiency() from public, anon, authenticated;

create trigger compliance_exceptions_company_matches_deficiency
  before insert or update on public.compliance_exceptions
  for each row execute function public.assert_company_matches_compliance_deficiency();

-- ---------------------------------------------------------------------------
-- Row level security - read-only for company members/staff on all four
-- tables. No insert/update/delete policy anywhere: every write goes through
-- apply_evaluation_result()/approve_compliance_exception() below, both
-- SECURITY DEFINER with their own explicit authorization check as the first
-- statement in the body (same "SECURITY DEFINER does not inherit RLS, so a
-- bypassed check here IS a cross-tenant IDOR" lesson resolve_assignment_
-- requirements()/set_company_feature_flag() already document) - never a
-- direct table write any authenticated role could issue, and deliberately no
-- "just mark it resolved/waived" shortcut exists anywhere in this schema: the
-- only paths that can ever move a deficiency out of 'open' are real
-- re-evaluation evidence (apply_evaluation_result()) or a real approved
-- exception (approve_compliance_exception()).
-- ---------------------------------------------------------------------------

alter table public.compliance_cases            enable row level security;
alter table public.compliance_evaluation_runs   enable row level security;
alter table public.compliance_deficiencies      enable row level security;
alter table public.compliance_exceptions        enable row level security;

create policy compliance_cases_select on public.compliance_cases
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy compliance_evaluation_runs_select on public.compliance_evaluation_runs
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy compliance_deficiencies_select on public.compliance_deficiencies
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy compliance_exceptions_select on public.compliance_exceptions
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- apply_evaluation_result() - the one write path from an evaluatePackage()
-- call to durable case/run/deficiency rows.
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER + explicit authorization check, first statement in the
-- body - same rolbypassrls gotcha as resolve_assignment_requirements()/
-- set_company_feature_flag(): this function is owned by postgres, which
-- bypasses RLS, so every read/write inside this body bypasses RLS on
-- compliance_cases/compliance_evaluation_runs/compliance_deficiencies
-- regardless of who calls it. Without the check below, any signed-in user of
-- any company could call this with a foreign company's ids and write rows
-- into that company's case history - a cross-tenant IDOR. Same generic
-- "not authorized" message this project always uses so the error itself
-- cannot be used to probe which foreign ids are real.
--
-- Atomic by construction: a plpgsql function body runs inside one implicit
-- transaction, and nothing below returns early mid-way through processing
-- findings/deficiencies - either the whole run (case + run row + every
-- deficiency upsert/resolve) commits, or (on any error) none of it does.
--
-- p_requirements_snapshot / p_findings_snapshot are the TypeScript caller's
-- own EvaluationResult.requirements / EvaluationResult.findings, serialized
-- to jsonb by complianceCaseRepository.ts's applyEvaluationResult() before
-- this is called - a near 1:1 parameter mapping of EvaluationResult's own
-- fields (assignmentId/documentPackageId/evaluatedAt/requirements/findings),
-- plus p_company_id/p_vendor_id/p_upload_request_id, which EvaluationResult
-- itself does not carry but a case/deficiency row must.
create or replace function public.apply_evaluation_result(
  p_company_id             uuid,
  p_vendor_id              uuid,
  p_assignment_id          uuid,
  p_upload_request_id      uuid,
  p_package_id             uuid,
  p_evaluated_at           timestamptz,
  p_requirements_snapshot  jsonb,
  p_findings_snapshot      jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_case_id     uuid;
  v_run_id      uuid;
  v_finding     jsonb;
  v_requirement jsonb;
  v_key         text;
  v_state       text;
  v_existing    public.compliance_deficiencies%rowtype;
begin
  if not (
    p_company_id in (select public.current_company_ids())
    or public.is_platform_admin()
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Get-or-create the case, keyed by (assignment_id, upload_request_id) -
  -- this project's established upsert idiom (see e.g.
  -- set_company_feature_flag(), 20260916000100_company_feature_flags.sql):
  -- insert ... on conflict ... do update ... returning id, which returns the
  -- id whether the row was just created or already existed.
  insert into public.compliance_cases (company_id, vendor_id, assignment_id, upload_request_id)
  values (p_company_id, p_vendor_id, p_assignment_id, p_upload_request_id)
  on conflict (assignment_id, upload_request_id)
  do update set updated_at = now()
  returning id into v_case_id;

  -- The immutable run row - always inserted, one per call, regardless of
  -- what (if anything) it changes below.
  insert into public.compliance_evaluation_runs (
    company_id, case_id, package_id, evaluated_at, requirements_snapshot, findings_snapshot
  ) values (
    p_company_id, v_case_id, p_package_id, p_evaluated_at, p_requirements_snapshot, p_findings_snapshot
  )
  returning id into v_run_id;

  -- Every deficient/unknown finding upserts (never duplicates) the matching
  -- (case_id, requirement_key) row - see the unique constraint on
  -- compliance_deficiencies.
  for v_finding in select * from jsonb_array_elements(p_findings_snapshot)
  loop
    v_key := v_finding ->> 'requirementKey';
    v_state := v_finding ->> 'state';

    continue when v_state not in ('deficient', 'unknown');

    select r into v_requirement
    from jsonb_array_elements(p_requirements_snapshot) r
    where r ->> 'key' = v_key
    limit 1;

    select * into v_existing
    from public.compliance_deficiencies
    where case_id = v_case_id and requirement_key = v_key;

    if not found then
      insert into public.compliance_deficiencies (
        company_id, case_id, requirement_key, status, kind, policy_type,
        expected, observed, explanation, evidence_document_ids,
        first_evaluation_run_id, last_evaluation_run_id
      ) values (
        p_company_id, v_case_id, v_key, 'open',
        nullif(v_requirement ->> 'kind', ''),
        nullif(v_requirement ->> 'policyType', ''),
        coalesce(v_finding -> 'expected', '{}'::jsonb),
        v_finding -> 'observed',
        coalesce(v_finding ->> 'explanation', ''),
        coalesce(
          (select array_agg(elem::uuid) from jsonb_array_elements_text(
            coalesce(v_finding -> 'evidenceDocumentIds', '[]'::jsonb)
          ) elem),
          '{}'::uuid[]
        ),
        v_run_id, v_run_id
      );
    elsif v_existing.status in ('open', 'resolved') then
      -- A prior fix that regressed (status was 'resolved') must reopen, not
      -- stay silently marked resolved - "closes only when evidence resolves
      -- it" cuts both ways. A 'waived' row is handled by neither this branch
      -- nor the implicit else below - it is the one status this function
      -- must never touch (see the migration docblock and this function's own
      -- header comment).
      update public.compliance_deficiencies
      set kind = nullif(v_requirement ->> 'kind', ''),
          policy_type = nullif(v_requirement ->> 'policyType', ''),
          expected = coalesce(v_finding -> 'expected', '{}'::jsonb),
          observed = v_finding -> 'observed',
          explanation = coalesce(v_finding ->> 'explanation', ''),
          evidence_document_ids = coalesce(
            (select array_agg(elem::uuid) from jsonb_array_elements_text(
              coalesce(v_finding -> 'evidenceDocumentIds', '[]'::jsonb)
            ) elem),
            '{}'::uuid[]
          ),
          last_evaluation_run_id = v_run_id,
          status = 'open',
          resolved_at = null,
          resolved_by_evaluation_run_id = null,
          updated_at = now()
      where id = v_existing.id;
    end if;
  end loop;

  -- Any OPEN deficiency for this case whose requirement_key does NOT appear
  -- as deficient/unknown in THIS run (verified, not_applicable, or simply
  -- absent this time) is resolved by this run. A 'waived' row is untouched
  -- here too - the `status = 'open'` filter already excludes it, same as the
  -- loop above.
  update public.compliance_deficiencies d
  set status = 'resolved',
      resolved_at = now(),
      resolved_by_evaluation_run_id = v_run_id,
      updated_at = now()
  where d.case_id = v_case_id
    and d.status = 'open'
    and not exists (
      select 1
      from jsonb_array_elements(p_findings_snapshot) f
      where f ->> 'requirementKey' = d.requirement_key
        and f ->> 'state' in ('deficient', 'unknown')
    );

  return v_case_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- approve_compliance_exception() - ComplianceExceptionInput's write path.
-- ---------------------------------------------------------------------------
--
-- Same SECURITY DEFINER + first-statement-authorization-check shape as
-- apply_evaluation_result() above, gated to owner/risk_manager specifically
-- (the plan's own requirement: "exception approval requires owner/risk_manager
-- role"), resolved via the deficiency's OWN case's company_id rather than a
-- company_id the caller supplies directly - a caller cannot claim a
-- deficiency belongs to a company they have a role in when it does not.
-- "Not found" and "found but caller lacks the role" share the same generic
-- error, this project's established anti-probing pattern; the deficiency's
-- status check below (already resolved/waived) is a distinct, specific
-- business-rule rejection, not an existence/ownership check, so it does not
-- need the same anti-probing treatment.
--
-- p_remaining_risk_acknowledged: the plan's own bullet requires
-- "remaining-risk acknowledgement" as part of approval even though
-- ComplianceExceptionInput's TS sketch in the plan excerpt omits the field -
-- treated the same way Task 9b's spec reviewer flagged an equivalent gap
-- ("almost certainly the plan excerpt was a simplified/earlier sketch", not
-- license to skip a bullet the plan explicitly lists) - see cases.ts's
-- ComplianceExceptionInput, which adds remainingRiskAcknowledged accordingly.
create or replace function public.approve_compliance_exception(
  p_deficiency_id               uuid,
  p_reason                      text,
  p_effective_on                date,
  p_expires_on                  date,
  p_supporting_document_id      uuid,
  p_vendor_visible              boolean,
  p_remaining_risk_acknowledged boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_deficiency    public.compliance_deficiencies%rowtype;
  v_exception_id  uuid;
begin
  select d.* into v_deficiency
  from public.compliance_deficiencies d
  where d.id = p_deficiency_id;

  if not found
     or not (
       public.has_company_role(v_deficiency.company_id, array['owner', 'risk_manager'])
       or public.is_platform_admin()
     )
  then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if v_deficiency.status <> 'open' then
    raise exception 'deficiency % is not open (current status: %) - an exception can only be approved for an open deficiency',
      p_deficiency_id, v_deficiency.status using errcode = '22023';
  end if;

  insert into public.compliance_exceptions (
    company_id, deficiency_id, reason, effective_on, expires_on,
    supporting_document_id, vendor_visible, remaining_risk_acknowledged, approved_by
  ) values (
    v_deficiency.company_id, p_deficiency_id, p_reason, p_effective_on, p_expires_on,
    p_supporting_document_id, p_vendor_visible, p_remaining_risk_acknowledged, auth.uid()
  )
  returning id into v_exception_id;

  update public.compliance_deficiencies
  set status = 'waived',
      waived_via_exception_id = v_exception_id,
      updated_at = now()
  where id = p_deficiency_id;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    v_deficiency.company_id, auth.uid(), 'compliance_exception_approved', 'compliance_deficiency',
    p_deficiency_id, jsonb_build_object(
      'exception_id', v_exception_id,
      'effective_on', p_effective_on,
      'expires_on', p_expires_on
    )
  );

  return v_exception_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Function grants - same established gotcha as every SECURITY DEFINER
-- function in this project: Supabase grants EXECUTE to anon/authenticated
-- directly at function-creation time, which a bare "revoke ... from public"
-- never touches. Revoke from all three named roles, then grant back
-- explicitly only to authenticated (both functions are meant to be called
-- directly by a signed-in company member - see each function's own docblock
-- for its own authorization check).
-- ---------------------------------------------------------------------------

revoke execute on function public.apply_evaluation_result(
  uuid, uuid, uuid, uuid, uuid, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_evaluation_result(
  uuid, uuid, uuid, uuid, uuid, timestamptz, jsonb, jsonb
) to authenticated;

revoke execute on function public.approve_compliance_exception(
  uuid, text, date, date, uuid, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.approve_compliance_exception(
  uuid, text, date, date, uuid, boolean, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- audit_log - widen action/target_type for compliance_exception_approved.
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
    'extraction_reviewer_edit', 'compliance_exception_approved'
  ));

alter table public.audit_log
  drop constraint audit_log_target_type_check;

alter table public.audit_log
  add constraint audit_log_target_type_check
  check (target_type in (
    'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
    'company_member', 'company_invitation', 'compliance_deficiency'
  ));
