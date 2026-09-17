-- Task 11b - reporting/exports/audit-history half of Task 11 (Task 11a
-- already built the bulk CSV import pipeline - see
-- 20260917001500_vendor_import.sql's own docblock). This migration is the
-- ONE schema-heavy piece of Task 11b: the point-in-time audit snapshot.
--
-- Every assignment-based report (project/trade, 30/60/90 expiry, missing,
-- open deficiencies, exceptions, unresponsive, bounced, time-to-compliance,
-- resubmissions, reviewer turnaround) reads LIVE data through ordinary RLS-
-- protected SELECTs - see src/data/repositories/reportRepository.ts - and
-- needs no new schema at all, exactly like every other read-mostly
-- repository in this project (requirementRepository.ts/projectRepository.ts
-- have no accompanying migration of their own either).
--
-- The point-in-time audit report is different: the plan's own bullet ("first
-- writes an immutable snapshot ... then renders CSV/PDF from that snapshot")
-- requires a durable, NEVER-re-queried row to render from later, so a report
-- generated today still reflects exactly what was true today even after the
-- vendor's coverage/deficiencies/exceptions change tomorrow. Same
-- immutable-snapshot convention already established twice in this schema -
-- document_extractions (20260917000900_versioned_extractions.sql) and
-- compliance_evaluation_runs (20260917001200_compliance_cases.sql): an
-- append-only table, no update trigger, one row per "as of right now" call.
--
-- create_audit_snapshot() deliberately does NOT reimplement requirement
-- resolution - it calls the existing resolve_assignment_requirements() RPC
-- (Task 4/9b) and freezes its output verbatim into requirements_snapshot,
-- the same "reuse, don't reimplement" discipline
-- applyEvaluationResult()/evaluatePackage.ts already establish for that
-- function elsewhere in this codebase.

-- ---------------------------------------------------------------------------
-- audit_snapshots - append-only, one row per create_audit_snapshot() call.
-- ---------------------------------------------------------------------------

create table public.audit_snapshots (
  id                     uuid primary key default gen_random_uuid(),
  -- Denormalised from project_vendor_assignments, same one-indexed-predicate
  -- RLS reasoning as every other child table in this schema. Kept honest by
  -- assert_company_matches_audit_snapshot_assignment() below.
  company_id             uuid not null references public.companies (id) on delete cascade,
  assignment_id          uuid not null references public.project_vendor_assignments (id) on delete cascade,
  snapshot_taken_at      timestamptz not null default now(),
  requested_by           uuid not null references auth.users (id),
  -- resolve_assignment_requirements(assignment_id)'s full output, frozen
  -- verbatim (jsonb_agg(to_jsonb(...))) at the moment this row is written -
  -- see that function's own docblock (20260917001100_resolved_requirement_configuration.sql)
  -- for its exact column shape.
  requirements_snapshot  jsonb not null,
  -- { policies: [...active vendor_policies for the assignment's vendor],
  --   deficiencies: [...compliance_deficiencies for every case tied to this
  --     assignment, any status], exceptions: [...compliance_exceptions for
  --     those deficiencies] } - the full point-in-time compliance picture,
  -- also frozen verbatim.
  evidence_snapshot      jsonb not null,
  created_at             timestamptz not null default now()
  -- No updated_at, no update trigger: this table is never updated after
  -- insert, same as document_extractions/compliance_evaluation_runs -
  -- "point-in-time" means once written, it is never edited.
);

create index audit_snapshots_company_idx on public.audit_snapshots (company_id);
create index audit_snapshots_assignment_idx on public.audit_snapshots (assignment_id, snapshot_taken_at desc);

-- ---------------------------------------------------------------------------
-- Integrity: company_id must equal the real assignment's own - same problem/
-- fix as assert_company_matches_compliance_case_assignment()
-- (20260917001200_compliance_cases.sql) and every other child table in this
-- schema. Belt-and-suspenders here: create_audit_snapshot() below is the
-- ONLY write path (no direct insert policy is granted to authenticated), and
-- it already sets company_id from the assignment row itself, but this
-- project's established convention is to add the trigger on every child
-- table regardless of whether the sole writer already gets it right.
-- ---------------------------------------------------------------------------

create or replace function public.assert_company_matches_audit_snapshot_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  a_company uuid;
begin
  select company_id into a_company
  from public.project_vendor_assignments where id = new.assignment_id;

  if a_company is null then
    raise exception 'assignment_id % does not exist', new.assignment_id using errcode = '23503';
  end if;

  if a_company <> new.company_id then
    raise exception 'company_id does not match project_vendor_assignments %', new.assignment_id
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_audit_snapshot_assignment() from public, anon, authenticated;

create trigger audit_snapshots_company_matches_assignment
  before insert on public.audit_snapshots
  for each row execute function public.assert_company_matches_audit_snapshot_assignment();

-- ---------------------------------------------------------------------------
-- Row level security - read-only for company members/staff, same shape as
-- compliance_cases/compliance_evaluation_runs. No insert/update/delete
-- policy anywhere: the only write path is create_audit_snapshot() below,
-- SECURITY DEFINER with its own explicit authorization check.
-- ---------------------------------------------------------------------------

alter table public.audit_snapshots enable row level security;

create policy audit_snapshots_select on public.audit_snapshots
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- create_audit_snapshot() - the "first write an immutable snapshot" half of
-- the plan's point-in-time audit report bullet.
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER + explicit authorization check as the first statement -
-- same rolbypassrls gotcha as every other SECURITY DEFINER function in this
-- schema (apply_evaluation_result()/resolve_assignment_requirements()): this
-- function is owned by postgres, which bypasses RLS, so every read/write
-- inside this body bypasses RLS on project_vendor_assignments/vendor_
-- policies/compliance_deficiencies/compliance_exceptions/audit_snapshots
-- regardless of who calls it. Without the check below, any signed-in user of
-- any company could snapshot a foreign assignment - a cross-tenant IDOR.
--
-- Calls resolve_assignment_requirements() itself (a plain SELECT from
-- inside another SECURITY DEFINER function - Postgres allows this, and that
-- function's own authorization check re-runs and passes since it reads the
-- SAME assignment this function already verified) rather than duplicating
-- its precedence logic.
create or replace function public.create_audit_snapshot(assignment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  -- The parameter is immediately copied into a v_-prefixed local and never
  -- referenced bare again below - same "avoid plpgsql's default
  -- variable_conflict=error ambiguity against a same-named table column"
  -- discipline import_vendor_row()'s own docblock already establishes
  -- (20260917001500_vendor_import.sql): compliance_cases/audit_snapshots
  -- both have a real `assignment_id` column, so a query below that joins
  -- either of those and references a bare `assignment_id` would otherwise
  -- raise "column reference \"assignment_id\" is ambiguous".
  v_assignment_id  uuid := assignment_id;
  v_assignment     public.project_vendor_assignments%rowtype;
  v_requirements   jsonb;
  v_evidence       jsonb;
  v_snapshot_id    uuid;
begin
  select * into v_assignment
  from public.project_vendor_assignments where id = v_assignment_id;

  if not found
     or not (
       v_assignment.company_id in (select public.current_company_ids())
       or public.is_platform_admin()
     )
  then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
  into v_requirements
  from public.resolve_assignment_requirements(v_assignment_id) r;

  select jsonb_build_object(
    'policies', coalesce(
      (select jsonb_agg(to_jsonb(p) order by p.policy_type)
       from public.vendor_policies p
       where p.vendor_id = v_assignment.vendor_id and p.status = 'active'),
      '[]'::jsonb
    ),
    'deficiencies', coalesce(
      (select jsonb_agg(to_jsonb(d) order by d.requirement_key)
       from public.compliance_deficiencies d
       join public.compliance_cases c on c.id = d.case_id
       where c.assignment_id = v_assignment_id),
      '[]'::jsonb
    ),
    'exceptions', coalesce(
      (select jsonb_agg(to_jsonb(e) order by e.approved_at desc)
       from public.compliance_exceptions e
       join public.compliance_deficiencies d on d.id = e.deficiency_id
       join public.compliance_cases c on c.id = d.case_id
       where c.assignment_id = v_assignment_id),
      '[]'::jsonb
    )
  ) into v_evidence;

  insert into public.audit_snapshots (
    company_id, assignment_id, requested_by, requirements_snapshot, evidence_snapshot
  ) values (
    v_assignment.company_id, v_assignment_id, auth.uid(), v_requirements, v_evidence
  )
  returning id into v_snapshot_id;

  return v_snapshot_id;
end;
$fn$;

comment on function public.create_audit_snapshot(uuid) is
  'Writes ONE immutable audit_snapshots row capturing resolve_assignment_requirements() output plus the assignment''s current vendor_policies/compliance_deficiencies/compliance_exceptions, all as of right now. Never updated afterward - src/workflows/auditSnapshots.ts renders a report from an existing snapshot id by reading ONLY these frozen jsonb columns, never live data. SECURITY DEFINER with an explicit authorization check as its first statement; see this migration''s docblock for why.';

-- Same established gotcha as every SECURITY DEFINER function in this
-- project: Supabase grants EXECUTE to anon/authenticated directly at
-- function-creation time, which a bare "revoke ... from public" never
-- touches. Revoke from all three named roles, then grant back explicitly
-- only to authenticated.
revoke execute on function public.create_audit_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.create_audit_snapshot(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- audit_log - widen action/target_type for the export action (Task 11b's
-- "CSV export is generated server-side with ... an audit row" bullet).
-- 'report' covers a company-wide report export (target_id = the company_id
-- itself - no other natural entity id exists for e.g. a project/trade
-- breakdown or an open-deficiencies list); 'audit_snapshot' covers exporting
-- a specific point-in-time snapshot (target_id = that audit_snapshots.id).
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
    'vendor_import_executed', 'report_exported'
  ));

alter table public.audit_log
  drop constraint audit_log_target_type_check;

alter table public.audit_log
  add constraint audit_log_target_type_check
  check (target_type in (
    'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
    'company_member', 'company_invitation', 'compliance_deficiency', 'vendor_import_batch',
    'company', 'audit_snapshot'
  ));
