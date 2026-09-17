-- Task 9b - widen resolve_assignment_requirements(uuid) to also return each
-- resolved requirement's `configuration` jsonb, so a package evaluator
-- (src/domain/compliance/evaluatePackage.ts) can tell WHICH limit field,
-- WHICH endorsement field, or WHICH document_kind a given rule is actually
-- checking.
--
-- requirement_profile_rules.configuration has existed since migration 18
-- (20260916000300_construction_core_expand.sql) but resolve_assignment_
-- requirements() never selected it, and every row written so far (the two
-- seeded "limit" rows per company from the Task 4 backfill migration,
-- 20260916000400_construction_core_backfill.sql) carries the column's bare
-- '{}'::jsonb default - there was no reader that needed anything more
-- specific than `kind: 'limit'` until now.
--
-- Interpretation contract this migration establishes (nothing in SQL
-- enforces this beyond the column comment below - it is a contract between
-- whoever authors/edits requirement_profile_rules rows and whoever reads
-- `configuration` back out, primarily evaluatePackage.ts):
--
--   kind = 'limit':              { "limitField": "each_occurrence" | "general_aggregate" }
--   kind = 'endorsement':        { "endorsementField": <name of a boolean field on
--                                   ExtractedPolicy (src/workflows/insuranceExtractionSchema.ts),
--                                   e.g. "additional_insured", "waiver_of_subrogation",
--                                   "primary_noncontributory",
--                                   "additional_insured_ongoing_operations",
--                                   "additional_insured_completed_operations",
--                                   "cancellation_notice_provided", "follows_form"> }
--   kind = 'document':            { "documentKind": <one of package_documents.document_kind's
--                                   vocabulary: 'certificate_of_insurance' |
--                                   'additional_insured_endorsement' |
--                                   'waiver_of_subrogation_endorsement' |
--                                   'primary_noncontributory_endorsement' | 'other'> }
--   kind = 'certificate_holder':  no configuration needed/used - always checked
--                                   against projects.certificate_holder_name/
--                                   certificate_holder_address, never anything
--                                   company-global.

comment on column public.requirement_profile_rules.configuration is
  'Per-kind interpretation detail resolve_assignment_requirements() passes through unread - see this migration''s (20260917001100) docblock for the full contract. kind=limit: {"limitField": "each_occurrence"|"general_aggregate"}. kind=endorsement: {"endorsementField": <boolean field name on ExtractedPolicy>}. kind=document: {"documentKind": <package_documents.document_kind value>}. kind=certificate_holder: unused, always {}.';

-- ---------------------------------------------------------------------------
-- Backfill the 2 existing seeded rows
-- ---------------------------------------------------------------------------
--
-- Idempotent: only touches rows still at the column's bare default, matching
-- this project's established migration idempotency convention (guard by
-- WHERE, never a blind UPDATE) - see e.g. the backfill migration's own
-- docblock.

update public.requirement_profile_rules
set configuration = '{"limitField": "each_occurrence"}'::jsonb
where rule_key = 'general_liability_each_occurrence_limit'
  and configuration = '{}'::jsonb;

update public.requirement_profile_rules
set configuration = '{"limitField": "general_aggregate"}'::jsonb
where rule_key = 'general_liability_general_aggregate_limit'
  and configuration = '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- resolve_assignment_requirements(): widen the return shape
-- ---------------------------------------------------------------------------
--
-- create or replace cannot widen a `returns table (...)` shape in place -
-- same lesson already learned in this project for apply_policy_renewal()
-- (see 20260903000600_certificate_holder_on_file.sql) - so the old signature
-- is dropped first. Body is otherwise an exact copy of the expand
-- migration's version (20260916000300_construction_core_expand.sql) with one
-- added column, `configuration`, threaded through the same base/overridden/
-- extra CTEs that already carry policy_type/kind/required/amount for the
-- base-rule and pure-override cases respectively.

drop function public.resolve_assignment_requirements(uuid);

create function public.resolve_assignment_requirements(assignment_id uuid)
returns table (
  key           text,
  policy_type   text,
  kind          text,
  required      boolean,
  amount        bigint,
  source        text,
  configuration jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_assignment public.project_vendor_assignments%rowtype;
  v_project    public.projects%rowtype;
  v_profile_id uuid;
  v_source     text;
begin
  select * into v_assignment
  from public.project_vendor_assignments where id = assignment_id;

  -- Same cross-tenant IDOR guard as the original function - see that
  -- migration's docblock for the full reasoning, not repeated here.
  if not found
     or not (
       v_assignment.company_id in (select public.current_company_ids())
       or public.is_platform_admin()
     )
  then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_project from public.projects where id = v_assignment.project_id;

  if v_assignment.requirement_profile_id is not null then
    v_profile_id := v_assignment.requirement_profile_id;
    v_source := 'assignment_profile';
  elsif v_project.default_requirement_profile_id is not null then
    v_profile_id := v_project.default_requirement_profile_id;
    v_source := 'project_profile';
  else
    select rp.id into v_profile_id
    from public.requirement_profiles rp
    where rp.company_id = v_assignment.company_id and rp.is_company_default
    limit 1;
    v_source := 'company_profile';
  end if;

  return query
  with base as (
    select
      r.rule_key       as rule_key,
      r.policy_type    as policy_type,
      r.rule_kind      as kind,
      r.required       as required,
      r.amount         as amount,
      r.configuration  as configuration
    from public.requirement_profile_rules r
    where r.profile_id = v_profile_id
  ),
  overridden as (
    select
      b.rule_key as key,
      b.policy_type,
      b.kind,
      coalesce((o.value ->> 'required')::boolean, b.required) as required,
      coalesce((o.value ->> 'amount')::bigint, b.amount)       as amount,
      case when o.rule_key is not null then 'project_override' else v_source end as source,
      coalesce(o.value -> 'configuration', b.configuration)    as configuration
    from base b
    left join public.project_requirement_overrides o
      on o.project_id = v_assignment.project_id and o.rule_key = b.rule_key
  ),
  extra as (
    select
      o.rule_key                                          as key,
      nullif(o.value ->> 'policyType', '')                 as policy_type,
      coalesce(nullif(o.value ->> 'kind', ''), 'document')  as kind,
      coalesce((o.value ->> 'required')::boolean, true)     as required,
      (o.value ->> 'amount')::bigint                        as amount,
      'project_override'::text                              as source,
      coalesce(o.value -> 'configuration', '{}'::jsonb)     as configuration
    from public.project_requirement_overrides o
    where o.project_id = v_assignment.project_id
      and not exists (select 1 from base b where b.rule_key = o.rule_key)
  )
  select * from overridden
  union all
  select * from extra;
end;
$fn$;

comment on function public.resolve_assignment_requirements(uuid) is
  'Resolves the effective requirement set for one assignment per the four-step precedence documented in 20260916000300_construction_core_expand.sql. Since Task 9b (20260917001100), also returns `configuration` - see that column''s comment on requirement_profile_rules for its per-kind interpretation contract. SECURITY DEFINER with an explicit authorization check as its first statement; see the function body for why.';

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
--
-- Dropping and recreating a function drops its grants too - this project has
-- hit this gotcha before (see the expand migration's own "Function grants"
-- section and supabase/README.md). Re-do them exactly as the original:
-- revoke from all three named roles (a bare "revoke ... from public" never
-- touches what Supabase grants directly to anon/authenticated at function-
-- creation time), then grant execute back only to authenticated.

revoke execute on function public.resolve_assignment_requirements(uuid) from public, anon, authenticated;
grant execute on function public.resolve_assignment_requirements(uuid) to authenticated;
