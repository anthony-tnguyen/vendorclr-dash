-- Task 4 / migration 21 - one-shot backfill of the construction core from
-- existing legacy data. Pairs with 20260916000300_construction_core_expand.sql;
-- see that migration's docblock for the overall expand/contract plan.
--
-- Two independent backfills happen here:
--
--   1. Every company gets its one seeded default requirement_profiles row
--      (the expand migration's trigger only covers companies created AFTER
--      this runs), and every existing compliance_requirements row becomes a
--      requirement_profile_rules row on that profile.
--   2. Every vendor whose (trimmed) project name is real - not blank, not
--      'Unassigned' - gets a projects row for that name (one per distinct
--      (company, name) pair) and a project_vendor_assignments row linking it
--      back to the vendor, carrying over contract_value/trade/risk_tier.
--      vendors.project / vendors.contract_value are left exactly as they are;
--      nothing here writes to public.vendors at all.
--
-- Idempotency: this is a one-shot data migration, not a reusable function, but
-- the Definition of Done requires it be safe to re-run against the same data
-- (e.g. a partial failure requiring a retry) without duplicating rows. Every
-- INSERT below is guarded by NOT EXISTS / ON CONFLICT against the natural key
-- the expand migration's UNIQUE constraints already define, so a second run
-- finds nothing left to do and inserts zero rows.

-- ---------------------------------------------------------------------------
-- 1a. One default requirement profile per existing company
-- ---------------------------------------------------------------------------

insert into public.requirement_profiles (company_id, name, is_company_default)
select c.id, 'Company Default', true
from public.companies c
where not exists (
  select 1 from public.requirement_profiles rp
  where rp.company_id = c.id and rp.is_company_default
);

-- ---------------------------------------------------------------------------
-- 1b. compliance_requirements -> requirement_profile_rules on that profile
-- ---------------------------------------------------------------------------
--
-- rule_key is derived deterministically as policy_type || '_' || limit_field
-- (e.g. 'general_liability_each_occurrence_limit'), which is unique per
-- profile unless a company has two compliance_requirements rows with the same
-- (policy_type, limit_field) pair - compliance_requirements' own
-- unique(company_id, label) does not prevent that, since label can differ
-- while (policy_type, limit_field) repeats. DISTINCT ON with a deterministic
-- ORDER BY (oldest row wins) resolves any such collision by picking exactly
-- one source row per rule_key rather than letting ON CONFLICT silently choose
-- an arbitrary one depending on insertion order.
insert into public.requirement_profile_rules
  (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount, configuration)
select distinct on (cr.company_id, cr.policy_type || '_' || cr.limit_field)
  cr.company_id,
  rp.id,
  cr.policy_type || '_' || cr.limit_field,
  cr.policy_type,
  'limit',
  true,
  cr.required_amount,
  '{}'::jsonb
from public.compliance_requirements cr
join public.requirement_profiles rp
  on rp.company_id = cr.company_id and rp.is_company_default
order by cr.company_id, cr.policy_type || '_' || cr.limit_field, cr.created_at, cr.id
on conflict (profile_id, rule_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2a. Distinct named vendor projects -> projects
-- ---------------------------------------------------------------------------
--
-- "Unassigned" is vendors.project's own default for a vendor with no real
-- project yet (migration 2) - not a real project name, so it is excluded
-- along with blank/whitespace-only values. Those vendors get no project and
-- no assignment; they are left exactly as they are today.
insert into public.projects (company_id, name, status)
select distinct v.company_id, btrim(v.project), 'active'
from public.vendors v
where btrim(v.project) <> '' and btrim(v.project) <> 'Unassigned'
  and not exists (
    select 1 from public.projects p
    where p.company_id = v.company_id and p.name = btrim(v.project)
  );

-- ---------------------------------------------------------------------------
-- 2b. Those same vendors -> project_vendor_assignments
-- ---------------------------------------------------------------------------
--
-- One assignment per (project, vendor): each vendor today has exactly one
-- project name, so this produces exactly one assignment per named-project
-- vendor - never a second vendors row, never a second assignment for the same
-- pair (the unique(project_id, vendor_id) constraint is the backstop; the NOT
-- EXISTS guard is what makes a second run of this migration a no-op).
insert into public.project_vendor_assignments
  (company_id, project_id, vendor_id, contract_value, trade_code, risk_classification, status)
select
  v.company_id,
  p.id,
  v.id,
  v.contract_value,
  v.trade,
  v.risk_tier,
  'active'
from public.vendors v
join public.projects p
  on p.company_id = v.company_id and p.name = btrim(v.project)
where btrim(v.project) <> '' and btrim(v.project) <> 'Unassigned'
  and not exists (
    select 1 from public.project_vendor_assignments a
    where a.project_id = p.id and a.vendor_id = v.id
  );

-- ---------------------------------------------------------------------------
-- Reconciliation queries
-- ---------------------------------------------------------------------------
--
-- Real, copy-pasteable SQL - run these against the live project after
-- applying this migration, not just read as prose. All four should either
-- match a known-good count or return zero rows.

-- (1) Distinct non-"Unassigned" (company, trimmed project) pairs among
--     vendors == projects rows created.
--
-- select
--   (select count(*) from (
--     select distinct company_id, btrim(project) as name
--     from public.vendors
--     where btrim(project) <> '' and btrim(project) <> 'Unassigned'
--   ) distinct_pairs) as expected_projects,
--   (select count(*) from public.projects) as actual_projects;

-- (2) Vendors with a non-"Unassigned" project == project_vendor_assignments
--     rows created (one assignment per such vendor).
--
-- select
--   (select count(*) from public.vendors
--    where btrim(project) <> '' and btrim(project) <> 'Unassigned') as expected_assignments,
--   (select count(*) from public.project_vendor_assignments) as actual_assignments;

-- (3) Every child row's company_id matches its parent chain. Zero rows means
--     integrity holds.
--
-- select 'project_vendor_assignments' as table_name, a.id
-- from public.project_vendor_assignments a
-- join public.projects p on p.id = a.project_id
-- join public.vendors v on v.id = a.vendor_id
-- where a.company_id <> p.company_id or a.company_id <> v.company_id
-- union all
-- select 'project_requirement_overrides', o.id
-- from public.project_requirement_overrides o
-- join public.projects p on p.id = o.project_id
-- where o.company_id <> p.company_id
-- union all
-- select 'requirement_profile_rules', r.id
-- from public.requirement_profile_rules r
-- join public.requirement_profiles rp on rp.id = r.profile_id
-- where r.company_id <> rp.company_id;

-- (4) Every backfilled requirement_profile_rules.amount matches the source
--     compliance_requirements.required_amount it was derived from. Zero rows
--     means every backfilled amount is correct.
--
-- select r.id, r.amount, cr.required_amount
-- from public.requirement_profile_rules r
-- join public.requirement_profiles rp on rp.id = r.profile_id and rp.is_company_default
-- join public.compliance_requirements cr
--   on cr.company_id = r.company_id
--   and cr.policy_type || '_' || cr.limit_field = r.rule_key
-- where r.amount is distinct from cr.required_amount;
