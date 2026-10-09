-- Per-vendor requirement settings.
--
-- Requirements have so far resolved through a four-step precedence
-- (assignment profile > project profile > company default profile, then a
-- project-level surgical override) in resolve_assignment_requirements(). This
-- adds a fifth, highest-precedence layer: a per-VENDOR override of one rule's
-- effective value, applied to every assignment that vendor has. It is the
-- data behind the vendor detail page's "Vendor requirements" panel, where a
-- customer selects/deselects requirements (and sets limit amounts) for one
-- specific vendor, overriding their company default for that vendor.
--
-- The table mirrors project_requirement_overrides exactly (migration
-- 20260916000300) - same typed `value` envelope, same keying by (owner_id,
-- rule_key), same integrity/updated_at triggers, same owner/risk_manager-only
-- write policy - only the owning parent differs (vendor, not project).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
--
-- `value` is the same small typed envelope project_requirement_overrides uses:
-- resolve_assignment_requirements() reads value->>'required' and
-- value->>'amount' to override an existing rule's disposition/amount, and when
-- rule_key matches no rule in the resolved set also reads value->>'policyType',
-- value->>'kind' and value->'configuration' to define a wholly vendor-specific
-- extra requirement. Missing keys fall back to the layer beneath. No CHECK on
-- the jsonb shape - same reasoning as project_requirement_overrides.
create table public.vendor_requirement_overrides (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  rule_key   text not null check (length(btrim(rule_key)) > 0),
  value      jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_id, rule_key)
);

create index vendor_requirement_overrides_company_id_idx
  on public.vendor_requirement_overrides (company_id);
create index vendor_requirement_overrides_vendor_id_idx
  on public.vendor_requirement_overrides (vendor_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance + cross-tenant integrity
-- ---------------------------------------------------------------------------

create trigger vendor_requirement_overrides_touch_updated_at
  before update on public.vendor_requirement_overrides
  for each row execute function public.touch_updated_at();

-- Child company_id must equal the owning vendor's company_id. Reuses the same
-- check every other vendor_id-keyed child table uses (migration 20260901000200).
create trigger vendor_requirement_overrides_company_matches_vendor
  before insert or update on public.vendor_requirement_overrides
  for each row execute function public.assert_company_matches_vendor();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Same shape as project_requirement_overrides: readable by the owning company
-- (and platform admins), writable only by owner/risk_manager - configuring a
-- requirement, even a one-vendor one, is a risk-management decision, not the
-- broader can_write_company() that operational data gets.
alter table public.vendor_requirement_overrides enable row level security;

create policy vendor_requirement_overrides_select on public.vendor_requirement_overrides
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy vendor_requirement_overrides_insert on public.vendor_requirement_overrides
  for insert to authenticated
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy vendor_requirement_overrides_update on public.vendor_requirement_overrides
  for update to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']))
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy vendor_requirement_overrides_delete on public.vendor_requirement_overrides
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- ---------------------------------------------------------------------------
-- resolve_assignment_requirements(): add the vendor-override layer
-- ---------------------------------------------------------------------------
--
-- Return shape is unchanged from migration 20260917001100, so create or
-- replace is enough (no drop/regrant needed). Body is that version with a
-- vendor-override layer (vend) threaded through the same CTEs, winning over
-- both the base rule and any project override:
--
--   required/amount:  coalesce(vendor, project, base)
--   source:           'vendor_override' when a vendor row matched this rule,
--                     else the prior 'project_override'/profile source
--
-- When there are no vendor_requirement_overrides rows for the assignment's
-- vendor, every coalesce falls straight through and the result is byte-for-byte
-- what it was before this migration.

create or replace function public.resolve_assignment_requirements(assignment_id uuid)
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

  -- Same cross-tenant IDOR guard as prior versions - see migration
  -- 20260916000300's docblock for the full reasoning, not repeated here.
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
  proj as (
    select o.rule_key, o.value
    from public.project_requirement_overrides o
    where o.project_id = v_assignment.project_id
  ),
  vend as (
    select o.rule_key, o.value
    from public.vendor_requirement_overrides o
    where o.vendor_id = v_assignment.vendor_id
  ),
  -- Base profile rules, with project then vendor overrides layered on top.
  resolved_base as (
    select
      b.rule_key as key,
      b.policy_type,
      b.kind,
      coalesce(
        (vo.value ->> 'required')::boolean,
        (po.value ->> 'required')::boolean,
        b.required
      ) as required,
      coalesce(
        (vo.value ->> 'amount')::bigint,
        (po.value ->> 'amount')::bigint,
        b.amount
      ) as amount,
      case
        when vo.rule_key is not null then 'vendor_override'
        when po.rule_key is not null then 'project_override'
        else v_source
      end as source,
      coalesce(
        vo.value -> 'configuration',
        po.value -> 'configuration',
        b.configuration
      ) as configuration
    from base b
    left join proj po on po.rule_key = b.rule_key
    left join vend vo on vo.rule_key = b.rule_key
  ),
  -- Project-only extra rules (no base rule), still overridable by the vendor.
  proj_extra as (
    select
      po.rule_key                                          as key,
      nullif(po.value ->> 'policyType', '')                 as policy_type,
      coalesce(nullif(po.value ->> 'kind', ''), 'document')  as kind,
      coalesce((vo.value ->> 'required')::boolean, (po.value ->> 'required')::boolean, true) as required,
      coalesce((vo.value ->> 'amount')::bigint, (po.value ->> 'amount')::bigint)             as amount,
      case when vo.rule_key is not null then 'vendor_override' else 'project_override' end   as source,
      coalesce(vo.value -> 'configuration', po.value -> 'configuration', '{}'::jsonb)        as configuration
    from proj po
    left join vend vo on vo.rule_key = po.rule_key
    where not exists (select 1 from base b where b.rule_key = po.rule_key)
  ),
  -- Vendor-only extra rules (no base rule, no project override).
  vend_extra as (
    select
      vo.rule_key                                          as key,
      nullif(vo.value ->> 'policyType', '')                 as policy_type,
      coalesce(nullif(vo.value ->> 'kind', ''), 'document')  as kind,
      coalesce((vo.value ->> 'required')::boolean, true)     as required,
      (vo.value ->> 'amount')::bigint                        as amount,
      'vendor_override'::text                                as source,
      coalesce(vo.value -> 'configuration', '{}'::jsonb)     as configuration
    from vend vo
    where not exists (select 1 from base b where b.rule_key = vo.rule_key)
      and not exists (select 1 from proj po where po.rule_key = vo.rule_key)
  )
  select * from resolved_base
  union all
  select * from proj_extra
  union all
  select * from vend_extra;
end;
$fn$;

comment on function public.resolve_assignment_requirements(uuid) is
  'Resolves the effective requirement set for one assignment. Precedence, lowest to highest: company/project/assignment profile (migration 20260916000300) -> project_requirement_overrides -> vendor_requirement_overrides (migration 20261009000300). Also returns `configuration` (Task 9b, 20260917001100). SECURITY DEFINER with an explicit authorization check as its first statement; see the function body for why.';
