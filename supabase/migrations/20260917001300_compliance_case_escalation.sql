-- Task 10b - the escalation/expiry half of Task 10 deliberately deferred out
-- of Task 10a's PR (see 20260917001200_compliance_cases.sql's own docblock:
-- "the escalation-reminder cron and the exception-expiry-reopening sweep are
-- Task 10b, not built here"). Extends that exact schema:
--
--   1. compliance_deficiencies gains correction_requested_at/escalation_level/
--      last_escalated_at - the fixed 3/7/14-day escalation clock. Hardcoded,
--      not company-configurable: the plan's own bullet says "make thresholds
--      company-configurable after pilot evidence" - i.e. after this ships and
--      real pilots show what actually needs tuning, not before. See
--      supabase/README.md's Known compromises for the explicit entry.
--   2. request_deficiency_correction() - a signed-in company member starts
--      the clock on an open deficiency.
--   3. mark_deficiency_escalated()/reopen_expired_compliance_exception() -
--      service-role-only, called exclusively by the new
--      compliance-housekeeping Edge Function, never by an app user. Same
--      "not SECURITY DEFINER, only ever reached via the service-role client
--      which already bypasses RLS" shape as record_document_extraction()
--      (20260917000900_versioned_extractions.sql) - there is no
--      caller-privilege boundary for SECURITY DEFINER to cross when the only
--      caller is service_role itself.
--   4. compliance_deficiencies_due_for_escalation/
--      compliance_exceptions_due_for_reopening - read-only views, same
--      security_invoker=true / no-explicit-grant convention as
--      documents_due_for_retry (20260903000300_automated_retry_queue.sql):
--      RLS on the underlying tables handles tenant isolation for any
--      authenticated reader, and the service role bypasses RLS structurally,
--      exactly like every other cron-consumed view in this schema.
--
-- "Expiry reopens the deficiency and creates a task" (the plan's own words):
-- this codebase has no task-tracking system. Interpreted here as an
-- audit_log row (this project's existing audit trail - see
-- reopen_expired_compliance_exception()'s own comment) plus an owner/
-- risk_manager email notification, the same "a human sees this and must
-- act" role a real task would play - documented as a deliberate scope
-- decision in supabase/README.md's Known compromises, not a silently
-- under-delivered requirement.

-- ---------------------------------------------------------------------------
-- compliance_deficiencies - the escalation clock
-- ---------------------------------------------------------------------------

alter table public.compliance_deficiencies
  add column correction_requested_at timestamptz,
  add column escalation_level smallint not null default 0 check (escalation_level between 0 and 3),
  add column last_escalated_at timestamptz;

comment on column public.compliance_deficiencies.correction_requested_at is
  'Set by request_deficiency_correction() - null until a correction request has actually been sent to the vendor for this deficiency. This is what starts the 3/7/14-day escalation clock (compliance_deficiencies_due_for_escalation).';

comment on column public.compliance_deficiencies.escalation_level is
  '0 = nothing escalated yet, 1/2/3 = the 3-day/7-day/14-day threshold has fired. Prevents mark_deficiency_escalated() from re-sending the same threshold on every housekeeping run.';

comment on column public.compliance_deficiencies.last_escalated_at is
  'Set by mark_deficiency_escalated() each time escalation_level advances.';

-- Powers compliance_deficiencies_due_for_escalation below - only open
-- deficiencies with a correction request outstanding are ever candidates.
create index compliance_deficiencies_escalation_idx
  on public.compliance_deficiencies (correction_requested_at)
  where status = 'open' and correction_requested_at is not null;

-- ---------------------------------------------------------------------------
-- apply_evaluation_result() - redefined here to reset the escalation clock
-- on reopen.
-- ---------------------------------------------------------------------------
--
-- Task 10a's version of this function (20260917001200_compliance_cases.sql)
-- predates correction_requested_at/escalation_level/last_escalated_at
-- entirely, so its "regressed - reopen a resolved deficiency" branch had no
-- reason to touch them. Now that those columns exist, leaving them alone on
-- reopen is a real bug found in this task's own code-quality review: a
-- deficiency that escalated to level 2 (say, 20 days after its original
-- correction request), then got resolved by a clean submission, then months
-- later regresses again on a wholly unrelated resubmission, would reopen
-- with the STALE escalation_level=2 and the STALE 20-day-old
-- correction_requested_at still in place - compliance_deficiencies_due_for_
-- escalation would then judge it immediately overdue for a level-3
-- escalation on the very next housekeeping run, even though nobody has
-- requested correction on this fresh episode at all yet. Resetting all
-- three columns to their "never requested" defaults on reopen treats a
-- regression as what it actually is: a new open episode that has not yet
-- had a correction requested, exactly like a brand-new deficiency.
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

  insert into public.compliance_cases (company_id, vendor_id, assignment_id, upload_request_id)
  values (p_company_id, p_vendor_id, p_assignment_id, p_upload_request_id)
  on conflict (assignment_id, upload_request_id)
  do update set updated_at = now()
  returning id into v_case_id;

  insert into public.compliance_evaluation_runs (
    company_id, case_id, package_id, evaluated_at, requirements_snapshot, findings_snapshot
  ) values (
    p_company_id, v_case_id, p_package_id, p_evaluated_at, p_requirements_snapshot, p_findings_snapshot
  )
  returning id into v_run_id;

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
      -- The `and status in ('open', 'resolved')` guard on the UPDATE below
      -- re-checks the row's status LIVE at UPDATE time rather than trusting
      -- the v_existing snapshot read above - see Task 10a's code-quality
      -- review fix for the full reasoning (a concurrent
      -- approve_compliance_exception() call landing between this SELECT and
      -- this UPDATE must not be clobbered).
      --
      -- correction_requested_at/escalation_level/last_escalated_at are reset
      -- to their "never requested" defaults whenever this branch actually
      -- reopens a RESOLVED row back to 'open' (see this function's own
      -- header comment above) - an already-open row being re-touched by a
      -- new run with unchanged status is not a "reopen" and does not need
      -- this reset (it never had its own clock disturbed), so the reset is
      -- conditioned on the row's live status actually being 'resolved'
      -- going into this statement, not on it merely being in this branch.
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
          correction_requested_at = case when status = 'resolved' then null else correction_requested_at end,
          escalation_level = case when status = 'resolved' then 0 else escalation_level end,
          last_escalated_at = case when status = 'resolved' then null else last_escalated_at end,
          updated_at = now()
      where id = v_existing.id
        and status in ('open', 'resolved');
    end if;
  end loop;

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
-- request_deficiency_correction() - starts the escalation clock.
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER + explicit authorization check as the first statement,
-- same rolbypassrls gotcha as apply_evaluation_result()/
-- approve_compliance_exception() (20260917001200_compliance_cases.sql): this
-- function is owned by postgres, which bypasses RLS on compliance_deficiencies
-- regardless of who calls it. "Not found" and "found but caller's company
-- doesn't match" share the same generic anti-probing error this project
-- always uses; the deficiency's status check below is a distinct,
-- non-anti-probing business-rule rejection (you cannot request correction of
-- something already resolved or waived), same split
-- approve_compliance_exception() already establishes for its own status
-- check.
--
-- Resets escalation_level/last_escalated_at to their "nothing sent yet"
-- state even on a deficiency that had a PRIOR correction request: relevant
-- when a deficiency was previously requested, then regressed/reopened by a
-- later apply_evaluation_result() run (that function's own reopen branch,
-- see its migration), and now needs a fresh correction request with a fresh
-- clock rather than inheriting a stale escalation_level from the earlier
-- request.
create or replace function public.request_deficiency_correction(p_deficiency_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_deficiency public.compliance_deficiencies%rowtype;
begin
  select d.* into v_deficiency
  from public.compliance_deficiencies d
  where d.id = p_deficiency_id;

  if not found
     or not (
       v_deficiency.company_id in (select public.current_company_ids())
       or public.is_platform_admin()
     )
  then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if v_deficiency.status <> 'open' then
    raise exception 'deficiency % is not open (current status: %) - correction can only be requested for an open deficiency',
      p_deficiency_id, v_deficiency.status using errcode = '22023';
  end if;

  update public.compliance_deficiencies
  set correction_requested_at = now(),
      escalation_level = 0,
      last_escalated_at = null,
      updated_at = now()
  where id = p_deficiency_id;
end;
$fn$;

revoke execute on function public.request_deficiency_correction(uuid) from public, anon, authenticated;
grant execute on function public.request_deficiency_correction(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- mark_deficiency_escalated() - service-role only, called exclusively by
-- compliance-housekeeping after it has successfully sent the escalation
-- notification for a row surfaced by compliance_deficiencies_due_for_escalation.
-- ---------------------------------------------------------------------------
--
-- Not SECURITY DEFINER: same reasoning as record_document_extraction()
-- (20260917000900_versioned_extractions.sql) - this is never granted to
-- anon/authenticated (see the revoke below) and is only ever reached via the
-- service-role client, which already bypasses RLS structurally. No
-- caller-privilege boundary for SECURITY DEFINER to cross here.
--
-- `where id = p_deficiency_id and status = 'open'` re-checks the deficiency's
-- LIVE status at write time rather than trusting whatever
-- compliance_deficiencies_due_for_escalation returned when the Edge Function
-- read it - a deficiency resolved or waived between that read and this call
-- must not be touched. 0 rows updated is a silent, correct no-op, the same
-- live-recheck-at-write-time discipline apply_evaluation_result()'s own
-- code-quality-review fix established for this function family (see that
-- migration's UPDATE ... where status in ('open', 'resolved') comment).
create or replace function public.mark_deficiency_escalated(
  p_deficiency_id uuid,
  p_new_level     smallint
)
returns void
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if p_new_level not between 1 and 3 then
    raise exception 'invalid escalation level %', p_new_level;
  end if;

  update public.compliance_deficiencies
  set escalation_level = p_new_level,
      last_escalated_at = now(),
      updated_at = now()
  where id = p_deficiency_id
    and status = 'open';
end;
$fn$;

revoke execute on function public.mark_deficiency_escalated(uuid, smallint) from public, anon, authenticated;
grant execute on function public.mark_deficiency_escalated(uuid, smallint) to service_role;

-- ---------------------------------------------------------------------------
-- reopen_expired_compliance_exception() - service-role only, called
-- exclusively by compliance-housekeeping for rows surfaced by
-- compliance_exceptions_due_for_reopening.
-- ---------------------------------------------------------------------------
--
-- Same "not SECURITY DEFINER, service-role only" shape as
-- mark_deficiency_escalated() above.
--
-- Idempotent by construction: `where id = p_exception_id and reopened_at is
-- null` means a second call against an already-reopened exception updates
-- zero rows and returns early, without a second deficiency-status flip or a
-- second audit_log row - calling this twice for the same exception (e.g. a
-- retried housekeeping run) is safe.
--
-- The deficiency UPDATE additionally rechecks `status = 'waived'` live at
-- write time, same defensive reasoning as mark_deficiency_escalated() above:
-- if the deficiency somehow already changed (a fresh evaluation run cannot
-- touch a waived row per apply_evaluation_result()'s own invariant, but a
-- human path is not something this function should assume never exists),
-- this must not clobber it.
create or replace function public.reopen_expired_compliance_exception(p_exception_id uuid)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_deficiency_id uuid;
  v_reopened_rows int;
begin
  select deficiency_id into v_deficiency_id
  from public.compliance_exceptions
  where id = p_exception_id;

  if v_deficiency_id is null then
    return null;
  end if;

  update public.compliance_exceptions
  set reopened_at = now()
  where id = p_exception_id
    and reopened_at is null;
  get diagnostics v_reopened_rows = row_count;

  -- Already reopened (idempotent no-op) - do not touch the deficiency or
  -- write a second audit_log row.
  if v_reopened_rows = 0 then
    return v_deficiency_id;
  end if;

  update public.compliance_deficiencies
  set status = 'open',
      updated_at = now()
  where id = v_deficiency_id
    and status = 'waived';

  -- The "creates a task" half of the plan's expiry bullet - see this
  -- migration's own docblock for the full reasoning. actor_id is null: this
  -- is a system action with no signed-in caller, same as every other
  -- service-role write in this schema.
  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  select d.company_id, null, 'compliance_exception_expired', 'compliance_deficiency', v_deficiency_id,
    jsonb_build_object('exception_id', p_exception_id)
  from public.compliance_deficiencies d
  where d.id = v_deficiency_id;

  return v_deficiency_id;
end;
$fn$;

revoke execute on function public.reopen_expired_compliance_exception(uuid) from public, anon, authenticated;
grant execute on function public.reopen_expired_compliance_exception(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- audit_log - widen action for compliance_exception_expired. target_type
-- already includes compliance_deficiency (added by 20260917001200).
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
    'extraction_reviewer_edit', 'compliance_exception_approved', 'compliance_exception_expired'
  ));

-- ---------------------------------------------------------------------------
-- email_outbox - widen template for the two new compliance-housekeeping
-- notifications, same widening pattern as every earlier addition to this
-- constraint (20260902000400_notification_emails.sql/
-- 20260902000500_renewal_reminders.sql).
-- ---------------------------------------------------------------------------

alter table public.email_outbox
  drop constraint email_outbox_template_check;

alter table public.email_outbox
  add constraint email_outbox_template_check
  check (template in (
    'vendor_onboarding', 'renewal_request', 'document_received', 'admin_review_needed',
    'renewal_reminder', 'compliance_deficiency_escalated', 'compliance_exception_expired'
  ));

-- ---------------------------------------------------------------------------
-- compliance_deficiencies_due_for_escalation - what compliance-housekeeping
-- reads to decide which open deficiencies cross the NEXT unfired 3/7/14-day
-- threshold. A deficiency at escalation_level = 3 is never included - the
-- plan defines exactly three thresholds, nothing further to escalate to.
-- ---------------------------------------------------------------------------

create view public.compliance_deficiencies_due_for_escalation
with (security_invoker = true) as
select
  d.id as deficiency_id,
  d.company_id,
  d.case_id,
  d.requirement_key,
  d.explanation,
  d.escalation_level,
  d.correction_requested_at,
  case d.escalation_level
    when 0 then 1
    when 1 then 2
    when 2 then 3
  end as next_level,
  c.vendor_id,
  c.assignment_id,
  c.upload_request_id,
  v.name as vendor_name,
  v.contact_name as vendor_contact_name,
  v.contact_email as vendor_contact_email
from public.compliance_deficiencies d
join public.compliance_cases c on c.id = d.case_id
join public.vendors v on v.id = c.vendor_id
where d.status = 'open'
  and d.correction_requested_at is not null
  and (
    (d.escalation_level = 0 and d.correction_requested_at <= now() - interval '3 days')
    or (d.escalation_level = 1 and d.correction_requested_at <= now() - interval '7 days')
    or (d.escalation_level = 2 and d.correction_requested_at <= now() - interval '14 days')
  );

-- ---------------------------------------------------------------------------
-- compliance_exceptions_due_for_reopening - what compliance-housekeeping
-- reads to decide which approved exceptions have expired and still need
-- their deficiency reopened. Excludes anything already reopened, and
-- excludes a deficiency somehow no longer 'waived' - defensive, matches
-- reopen_expired_compliance_exception()'s own live recheck.
-- ---------------------------------------------------------------------------

create view public.compliance_exceptions_due_for_reopening
with (security_invoker = true) as
select
  e.id as exception_id,
  e.company_id,
  e.deficiency_id,
  e.reason,
  e.expires_on,
  d.explanation,
  d.requirement_key,
  d.case_id,
  c.vendor_id,
  v.name as vendor_name,
  v.contact_name as vendor_contact_name,
  v.contact_email as vendor_contact_email
from public.compliance_exceptions e
join public.compliance_deficiencies d on d.id = e.deficiency_id
join public.compliance_cases c on c.id = d.case_id
join public.vendors v on v.id = c.vendor_id
where e.expires_on <= current_date
  and e.reopened_at is null
  and d.status = 'waived';
