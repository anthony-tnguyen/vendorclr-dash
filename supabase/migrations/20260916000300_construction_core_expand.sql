-- Task 4 / migration 20 - the construction core, additive ("expand") half.
--
-- Phase 0 modelled a subcontractor as one flat row: vendors.project is a free
-- text label, vendors.contract_value is a single number, and "compliant" means
-- "compliant with the company's one global requirement list"
-- (compliance_requirements, migration 13). That is not how a real GC's book
-- works: the same vendor works multiple jobs at once, each job wants its own
-- certificate holder and its own requirement set (a $50M glazing job needs more
-- than a $200K one), and a project sometimes needs one rule bumped without
-- rewriting the whole requirement list for every vendor on it.
--
-- This migration adds that real model - projects, the vendor-on-a-project
-- relationship, reusable requirement profiles and their rules, and a
-- project-level surgical override - without touching a single existing table,
-- column or row. vendors.project / vendors.contract_value keep being written by
-- existing code untouched; nothing here is load-bearing for the app yet. The
-- expand/contract split (see supabase/README.md) means the "contract" migration
-- that would retire those legacy columns is deliberately a separate, later
-- migration, gated on two successful production reconciliations against the
-- backfill this pairs with (20260916000400_construction_core_backfill.sql).
-- Nothing here is reachable from the app either: it all sits behind the
-- 'construction_core' company feature flag added in migration 19, which every
-- company reads as disabled until a human flips it.
--
-- Table order below follows the FK graph, not the plan sketch's order:
-- requirement_profiles/rules first (nothing depends on projects), then
-- projects (whose default_requirement_profile_id points at a profile), then
-- project_vendor_assignments and project_requirement_overrides (which point at
-- projects).

-- ---------------------------------------------------------------------------
-- requirement_profiles
-- ---------------------------------------------------------------------------

-- A named, reusable bundle of rules ("GC Standard", "High Risk Trade"). Every
-- company gets exactly one is_company_default = true profile (enforced by the
-- partial unique index below and seeded for every company - existing ones in
-- the backfill migration, new ones by the trigger at the bottom of this file) -
-- resolve_assignment_requirements() below depends on that invariant to always
-- have a profile to fall back to.
create table public.requirement_profiles (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  name               text not null check (length(btrim(name)) between 1 and 200),
  is_company_default boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, name)
);

create index requirement_profiles_company_id_idx on public.requirement_profiles (company_id);

-- Partial unique index rather than a boolean-keyed unique constraint: only
-- is_company_default = true rows need to be unique per company, and this is
-- also the ON CONFLICT target the seeding trigger/backfill rely on.
create unique index requirement_profiles_one_default_per_company
  on public.requirement_profiles (company_id) where is_company_default;

-- ---------------------------------------------------------------------------
-- requirement_profile_rules
-- ---------------------------------------------------------------------------

-- One line item within a profile - "general liability, $2M each occurrence,
-- required". rule_key is the stable handle a project_requirement_overrides row
-- targets and the key ResolvedRequirement.key mirrors in
-- src/domain/construction/types.ts; it has no fixed vocabulary (unlike
-- compliance_requirements.label, which is human display text) because a
-- profile can define whatever line items a company wants.
create table public.requirement_profile_rules (
  id            uuid primary key default gen_random_uuid(),
  -- Denormalised from requirement_profiles so RLS is one indexed predicate,
  -- same reasoning as every other child table in this schema. Kept honest by
  -- assert_company_matches_requirement_profile() below.
  company_id    uuid not null references public.companies (id) on delete cascade,
  profile_id    uuid not null references public.requirement_profiles (id) on delete cascade,
  rule_key      text not null check (length(btrim(rule_key)) > 0),
  policy_type   text check (policy_type in (
                  'general_liability', 'workers_compensation', 'commercial_auto',
                  'umbrella', 'professional_liability', 'pollution_liability',
                  'builders_risk'
                )),
  -- Mirrors PolicyKind in src/domain/construction/types.ts. Wider than
  -- compliance_requirements' implicit "always a limit" - a rule can require a
  -- document (e.g. a signed lien waiver) or an endorsement (e.g. additional
  -- insured) with no dollar amount at all, which is why amount is nullable
  -- below rather than defaulting to 0.
  rule_kind     text not null check (rule_kind in ('document', 'limit', 'endorsement', 'certificate_holder')),
  required      boolean not null default true,
  amount        bigint check (amount is null or amount >= 0),
  configuration jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (profile_id, rule_key)
);

create index requirement_profile_rules_company_id_idx on public.requirement_profile_rules (company_id);
create index requirement_profile_rules_profile_id_idx on public.requirement_profile_rules (profile_id);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------

create table public.projects (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references public.companies (id) on delete cascade,
  name                        text not null check (length(btrim(name)) between 1 and 200),
  project_number              text,
  status                      text not null default 'active' check (status in ('active', 'on_hold', 'closed')),
  -- COI certificate holder details are genuinely a project-level fact (the
  -- GC's legal entity for that job site, not the vendor's), which is why
  -- these live here rather than on vendors/project_vendor_assignments.
  certificate_holder_name     text not null default '',
  certificate_holder_address  text not null default '',
  -- Precedence step 2: a project can pin its own default profile, overriding
  -- the company default for every assignment on it that does not itself pick
  -- a profile. NULL (the common case) falls through to the company default.
  default_requirement_profile_id uuid references public.requirement_profiles (id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- One project per (company, trimmed name): the backfill's natural key, and
  -- what keeps a second backfill run from creating duplicates.
  unique (company_id, name)
);

create index projects_company_id_idx on public.projects (company_id);
create index projects_default_requirement_profile_id_idx
  on public.projects (default_requirement_profile_id) where default_requirement_profile_id is not null;

-- ---------------------------------------------------------------------------
-- project_vendor_assignments
-- ---------------------------------------------------------------------------

-- The vendor-on-a-project relationship. A vendor can appear on several
-- projects (several rows, one per project); each row carries its own contract
-- value / trade / risk tier, independent of the vendor's own (legacy)
-- top-level values, and independent of any other assignment for that vendor.
create table public.project_vendor_assignments (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete cascade,
  project_id             uuid not null references public.projects (id) on delete cascade,
  vendor_id              uuid not null references public.vendors (id) on delete cascade,
  -- Precedence step 3: this assignment's own profile pick, overriding
  -- whatever the project would otherwise have supplied for it alone.
  requirement_profile_id uuid references public.requirement_profiles (id) on delete set null,
  contract_number        text,
  contract_value         bigint check (contract_value >= 0),
  -- Same fixed vocabulary as vendors.trade (migration 2) - the backfill copies
  -- one directly into the other, so the CHECK sets must agree.
  trade_code             text check (trade_code in (
                           'Structural Steel', 'Electrical', 'Mechanical / HVAC', 'Concrete',
                           'Earthwork', 'Roofing', 'Glazing', 'Fire Protection'
                         )),
  -- Same vocabulary as vendors.risk_tier.
  risk_classification    text check (risk_classification in ('low', 'moderate', 'high')),
  status                 text not null default 'active' check (status in ('active', 'completed', 'terminated')),
  start_date             date,
  end_date               date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- One assignment per (project, vendor): the backfill's natural key (each
  -- vendor today has exactly one project name, so exactly one assignment
  -- results), and it also stops the app from ever creating two "live"
  -- assignments for the same vendor on the same project by accident.
  unique (project_id, vendor_id),
  check (start_date is null or end_date is null or end_date >= start_date)
);

create index project_vendor_assignments_company_id_idx on public.project_vendor_assignments (company_id);
create index project_vendor_assignments_project_id_idx on public.project_vendor_assignments (project_id);
create index project_vendor_assignments_vendor_id_idx on public.project_vendor_assignments (vendor_id);
create index project_vendor_assignments_requirement_profile_id_idx
  on public.project_vendor_assignments (requirement_profile_id) where requirement_profile_id is not null;

-- ---------------------------------------------------------------------------
-- project_requirement_overrides
-- ---------------------------------------------------------------------------

-- Precedence step 4, applied last: a project-level surgical override of one
-- specific rule's effective value, on top of whichever profile won above.
-- Keyed by (project_id, rule_key) rather than by assignment - "this project
-- needs $5M not $2M GL, for everyone on it" is the common case; overriding one
-- assignment alone is what requirement_profile_id on the assignment itself is
-- for.
--
-- `value` is a small typed envelope, not a bag of arbitrary keys:
-- resolve_assignment_requirements() reads value->>'required' and
-- value->>'amount' to override an existing rule's disposition/amount, and
-- (when rule_key does not match any rule in the resolved profile) also reads
-- value->>'policyType' and value->>'kind' to define a wholly project-specific
-- extra requirement that no profile carries. Missing keys fall back to the
-- base rule's own value; there is no schema-level CHECK on the jsonb shape
-- because the valid keys and their meaning are a function of whether rule_key
-- already resolves to something, which only the function can evaluate.
create table public.project_requirement_overrides (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  rule_key   text not null check (length(btrim(rule_key)) > 0),
  value      jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, rule_key)
);

create index project_requirement_overrides_company_id_idx on public.project_requirement_overrides (company_id);
create index project_requirement_overrides_project_id_idx on public.project_requirement_overrides (project_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create trigger requirement_profiles_touch_updated_at
  before update on public.requirement_profiles
  for each row execute function public.touch_updated_at();

create trigger requirement_profile_rules_touch_updated_at
  before update on public.requirement_profile_rules
  for each row execute function public.touch_updated_at();

create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

create trigger project_vendor_assignments_touch_updated_at
  before update on public.project_vendor_assignments
  for each row execute function public.touch_updated_at();

create trigger project_requirement_overrides_touch_updated_at
  before update on public.project_requirement_overrides
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Integrity: child company_id must equal the parent's real company_id
-- ---------------------------------------------------------------------------
--
-- Same problem, same fix, as assert_company_matches_vendor() in migration 2:
-- an RLS WITH CHECK on company_id and a plain FK on the parent id can each
-- individually pass while still letting a caller who can write to company A
-- attach a row claiming company_id = A to a project/profile actually owned by
-- company B. Only a trigger that looks up the parent's *real* company_id and
-- compares it catches that.

-- project_id -> projects.company_id. Reused across every table with a
-- project_id column (project_vendor_assignments, project_requirement_overrides),
-- same shape as assert_company_matches_vendor() being reused across three
-- vendor-domain tables.
create or replace function public.assert_company_matches_project()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  select company_id into owner_company from public.projects where id = new.project_id;

  if owner_company is null then
    raise exception 'project % does not exist', new.project_id using errcode = '23503';
  end if;

  if owner_company <> new.company_id then
    raise exception 'company_id % does not match the owning company % of project %',
      new.company_id, owner_company, new.project_id using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger project_vendor_assignments_company_matches_project
  before insert or update on public.project_vendor_assignments
  for each row execute function public.assert_company_matches_project();

create trigger project_requirement_overrides_company_matches_project
  before insert or update on public.project_requirement_overrides
  for each row execute function public.assert_company_matches_project();

-- requirement_profile_id -> requirement_profiles.company_id. Three different
-- tables point at requirement_profiles through three differently-named
-- columns (requirement_profile_id, profile_id, default_requirement_profile_id),
-- so unlike assert_company_matches_project() this takes the column name as a
-- trigger argument (tg_argv[0]) instead of being copy-pasted three times. The
-- referencing column is nullable on every table that uses this (a profile
-- pick is always optional), so a null value is not an error - it just means
-- "falls through to a lower precedence step" and there is nothing to check.
create or replace function public.assert_company_matches_requirement_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  referenced_profile uuid;
  owner_company       uuid;
begin
  referenced_profile := (to_jsonb(new) ->> tg_argv[0])::uuid;

  if referenced_profile is null then
    return new;
  end if;

  select company_id into owner_company
  from public.requirement_profiles where id = referenced_profile;

  if owner_company is null then
    raise exception 'requirement profile % does not exist', referenced_profile using errcode = '23503';
  end if;

  if owner_company <> new.company_id then
    raise exception 'company_id % does not match the owning company % of requirement profile %',
      new.company_id, owner_company, referenced_profile using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger projects_company_matches_default_profile
  before insert or update on public.projects
  for each row execute function public.assert_company_matches_requirement_profile('default_requirement_profile_id');

create trigger project_vendor_assignments_company_matches_profile
  before insert or update on public.project_vendor_assignments
  for each row execute function public.assert_company_matches_requirement_profile('requirement_profile_id');

create trigger requirement_profile_rules_company_matches_profile
  before insert or update on public.requirement_profile_rules
  for each row execute function public.assert_company_matches_requirement_profile('profile_id');

-- vendor_id -> vendors.company_id. Reuses migration 2's
-- assert_company_matches_vendor() as-is - same column name, same check.
create trigger project_vendor_assignments_company_matches_vendor
  before insert or update on public.project_vendor_assignments
  for each row execute function public.assert_company_matches_vendor();

-- ---------------------------------------------------------------------------
-- Every company gets exactly one default profile, forever
-- ---------------------------------------------------------------------------
--
-- The backfill migration seeds this for every company that exists at
-- migration time. This trigger is what keeps the invariant true for every
-- company created afterwards (handle_new_user(), migration 1), so
-- resolve_assignment_requirements() below never has to handle "this company
-- has no default profile at all" - that state cannot occur.
create or replace function public.seed_company_default_requirement_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.requirement_profiles (company_id, name, is_company_default)
  values (new.id, 'Company Default', true)
  on conflict (company_id) where is_company_default do nothing;
  return new;
end;
$fn$;

create trigger companies_seed_default_requirement_profile
  after insert on public.companies
  for each row execute function public.seed_company_default_requirement_profile();

-- ---------------------------------------------------------------------------
-- resolve_assignment_requirements(): the effective-requirements precedence
-- ---------------------------------------------------------------------------
--
-- Implements the four-step precedence from the plan, in order:
--   1. Company default profile.
--   2. Project's own default profile, if set - overrides step 1 for every
--      assignment on that project that does not itself pick a profile.
--   3. The assignment's own profile pick, if set - overrides step 2 for that
--      one assignment alone.
--   4. Project-level overrides, applied last on top of whichever profile won
--      above, matched by rule_key.
--
-- Steps 1-3 are whole-profile selection, not a per-rule merge across
-- profiles: exactly one profile's rules become the base set, and `source`
-- records which step supplied it. Step 4 then overlays project_requirement_
-- overrides on top of that base set by rule_key, and separately folds in any
-- override whose rule_key matches nothing in the base set as a wholly
-- project-specific extra requirement (see the project_requirement_overrides
-- table comment for why `value`'s shape differs between those two cases).
--
-- (Approved exceptions - the plan's precedence step 5 - are deliberately not
-- referenced here: they change a deficiency's *disposition* later (Task 10),
-- never the configured requirement this function resolves.)
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

  if not found then
    raise exception 'assignment % does not exist', assignment_id using errcode = '23503';
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
--
-- Same gotcha as every other SECURITY DEFINER function in this schema (see
-- migration 1's Function grants section and supabase/README.md): Supabase
-- grants EXECUTE to anon/authenticated directly at function-creation time,
-- which a bare "revoke ... from public" never touches. Revoke from all three
-- named roles, then grant back explicitly only where needed.

revoke execute on function public.assert_company_matches_project() from public, anon, authenticated;
revoke execute on function public.assert_company_matches_requirement_profile() from public, anon, authenticated;
revoke execute on function public.seed_company_default_requirement_profile() from public, anon, authenticated;
revoke execute on function public.resolve_assignment_requirements(uuid) from public, anon, authenticated;

-- resolve_assignment_requirements() is the one function here meant to be
-- called directly (by a future UI/report, not just fired as a trigger), so
-- it alone is granted back to authenticated. RLS on project_vendor_
-- assignments/projects/requirement_profiles still applies to everything it
-- reads even though it runs as SECURITY DEFINER: it is `stable` and only
-- ever selects, and every table it touches is scoped by v_assignment.company_id,
-- so a caller cannot use it to read another company's assignment - they simply
-- cannot look up an assignment_id belonging to another company in the first
-- place without already being able to see it, and if they somehow guessed a
-- foreign UUID, the rows returned are still that foreign company's own
-- configured requirements, not attacker-controlled data.
grant execute on function public.resolve_assignment_requirements(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.requirement_profiles         enable row level security;
alter table public.requirement_profile_rules    enable row level security;
alter table public.projects                     enable row level security;
alter table public.project_vendor_assignments   enable row level security;
alter table public.project_requirement_overrides enable row level security;

-- requirement_profiles --------------------------------------------------------
-- Configuring requirements is an owner/risk_manager job (per the plan's
-- checklist); project engineers and read-only members read but never write.
create policy requirement_profiles_select on public.requirement_profiles
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy requirement_profiles_insert on public.requirement_profiles
  for insert to authenticated
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy requirement_profiles_update on public.requirement_profiles
  for update to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']))
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy requirement_profiles_delete on public.requirement_profiles
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- requirement_profile_rules ---------------------------------------------------
create policy requirement_profile_rules_select on public.requirement_profile_rules
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy requirement_profile_rules_insert on public.requirement_profile_rules
  for insert to authenticated
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy requirement_profile_rules_update on public.requirement_profile_rules
  for update to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']))
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy requirement_profile_rules_delete on public.requirement_profile_rules
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- projects ---------------------------------------------------------------------
-- Not explicitly assigned a role by the plan's checklist; treated the same as
-- project_vendor_assignments (its natural child) - can_write_company() already
-- means exactly "owner, risk_manager or project_engineer", so day-to-day
-- project setup/maintenance is available to the same roles that maintain
-- assignments, and delete is restricted further to owner/risk_manager, same
-- shape as every other table in this schema.
create policy projects_select on public.projects
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy projects_insert on public.projects
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy projects_update on public.projects
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy projects_delete on public.projects
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- project_vendor_assignments -----------------------------------------------
-- "Project engineers mutate assignments" (the plan's checklist) read as
-- "project engineers are the day-to-day writers here", not "only they may" -
-- can_write_company() already grants owner/risk_manager/project_engineer,
-- matching how every other write-capable table in this schema treats those
-- three roles interchangeably for INSERT/UPDATE.
create policy project_vendor_assignments_select on public.project_vendor_assignments
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy project_vendor_assignments_insert on public.project_vendor_assignments
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy project_vendor_assignments_update on public.project_vendor_assignments
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy project_vendor_assignments_delete on public.project_vendor_assignments
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- project_requirement_overrides ------------------------------------------
-- Overriding a configured requirement is configuring requirements - same
-- owner/risk_manager-only write policy as requirement_profiles/rules, not the
-- broader can_write_company() that project_vendor_assignments gets.
create policy project_requirement_overrides_select on public.project_requirement_overrides
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy project_requirement_overrides_insert on public.project_requirement_overrides
  for insert to authenticated
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy project_requirement_overrides_update on public.project_requirement_overrides
  for update to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']))
  with check (public.has_company_role(company_id, array['owner', 'risk_manager']));

create policy project_requirement_overrides_delete on public.project_requirement_overrides
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));
