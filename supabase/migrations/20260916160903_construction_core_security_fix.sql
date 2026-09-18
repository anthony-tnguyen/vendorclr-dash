-- Fixes two issues found in spec review of migration 20
-- (20260916000300_construction_core_expand.sql), before that work merges:
--
-- 1. (Security, blocking) resolve_assignment_requirements(uuid) is SECURITY
--    DEFINER, owned by postgres (rolbypassrls = true), and looked up the
--    assignment purely by caller-supplied id with no membership check - a
--    cross-tenant IDOR letting any signed-in user read any other company's
--    resolved requirements. Fixed by adding an explicit authorization check
--    as the function's first statement, same pattern as
--    set_company_feature_flag() (migration 19).
--
-- 2. (Data integrity) Nothing stopped an owner/risk_manager from deleting or
--    demoting the one is_company_default = true row for their own company,
--    which would make resolve_assignment_requirements() silently resolve to
--    zero required rules for every assignment relying on the company
--    default. Fixed by a BEFORE UPDATE OR DELETE trigger on
--    requirement_profiles blocking that, with an explicit exemption for a
--    cascading delete of the whole company (which removes the need for a
--    default at all, not just the default row itself).

-- ---------------------------------------------------------------------------
-- A company's default profile can never be fully removed
-- ---------------------------------------------------------------------------

create or replace function public.assert_not_last_default_requirement_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if old.is_company_default and (tg_op = 'DELETE' or new.is_company_default = false) then
    -- A cascading delete of the whole company (companies' own row removed,
    -- cascading via "on delete cascade" through every child table including
    -- this one) tears down every row for that company together - there is no
    -- longer-lived company left for "must always have a default" to protect.
    -- Only block a standalone removal/demotion that would leave the company
    -- itself still around with no default. The parent row is already gone
    -- (visible within this same transaction) by the time a cascaded delete
    -- reaches here, which is what distinguishes the two cases.
    if tg_op = 'DELETE' and not exists (
      select 1 from public.companies where id = old.company_id
    ) then
      return old;
    end if;

    raise exception
      'company % must always have exactly one default requirement profile - promote a replacement before removing this one',
      old.company_id using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$fn$;

create trigger requirement_profiles_block_removing_last_default
  before update or delete on public.requirement_profiles
  for each row execute function public.assert_not_last_default_requirement_profile();

-- ---------------------------------------------------------------------------
-- resolve_assignment_requirements(): cross-tenant IDOR fix
-- ---------------------------------------------------------------------------

create or replace function public.resolve_assignment_requirements(assignment_id uuid)
returns table (
  key         text,
  policy_type text,
  kind        text,
  required    boolean,
  amount      bigint,
  source      text
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

  -- One check covers both "does not exist" and "exists but is a different
  -- company's assignment" with the exact same exception, on purpose - so the
  -- error itself cannot be used to probe which foreign assignment ids are
  -- real.
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
      r.rule_key     as rule_key,
      r.policy_type  as policy_type,
      r.rule_kind    as kind,
      r.required     as required,
      r.amount       as amount
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
      case when o.rule_key is not null then 'project_override' else v_source end as source
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
      'project_override'::text                              as source
    from public.project_requirement_overrides o
    where o.project_id = v_assignment.project_id
      and not exists (select 1 from base b where b.rule_key = o.rule_key)
  )
  select * from overridden
  union all
  select * from extra;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

revoke execute on function public.assert_not_last_default_requirement_profile() from public, anon, authenticated;
revoke execute on function public.resolve_assignment_requirements(uuid) from public, anon, authenticated;
grant execute on function public.resolve_assignment_requirements(uuid) to authenticated;
