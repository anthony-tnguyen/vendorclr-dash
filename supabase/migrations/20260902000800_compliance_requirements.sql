-- Phase 3 continued / migration 13 - match against what a client actually
-- requires, not just what changed.
--
-- Retires vendor_coverage_limits, flagged as a known compromise since Phase
-- 0: it co-located required (a company-wide policy) and carried (a
-- per-vendor, live fact already tracked precisely on vendor_policies) under
-- one row with no fixed vocabulary tying a label to a policy_type - there
-- was never a reliable way to compare the two automatically. No application
-- code ever wrote to it (only supabase/seed.sql, dev-only sample data); it
-- was read-only display with numbers a human had to keep in sync by hand.
--
-- compliance_requirements replaces it:
--
--   - Defined once per company, not per vendor - "every sub must carry $2M
--     GL" is a company policy, not a per-vendor fact. Per-trade/per-contract
--     tiering (a $50M glazing job probably wants more than a $200K one) is a
--     real future need but out of scope for this pass - see Known
--     compromises in supabase/README.md.
--   - policy_type + limit_field make a requirement machine-comparable
--     against vendor_policies for the first time - the actual new
--     capability this migration adds, not just a data-model move.
--     matchExtractedPolicy() (src/workflows/complianceEngine.ts) now checks
--     a certificate's extracted limit against these before letting an
--     otherwise-clean renewal auto-apply: a renewal that is internally
--     consistent (same carrier, same policy number, a later date) but falls
--     below what the company requires no longer sails through unchecked -
--     it routes to review like any other outcome matchExtractedPolicy()
--     cannot resolve automatically.
--
-- carried_amount is gone entirely, not migrated: it is read live from
-- vendor_policies (each_occurrence_limit/general_aggregate_limit on the
-- vendor's ACTIVE policy of the requirement's policy_type, or 0 if none) in
-- application code (toCoverageLimits() in supabaseRepository.ts), the same
-- "read the live source of truth, do not cache a second copy" principle
-- every other derived field in this schema already follows.

drop table public.vendor_coverage_limits;

create table public.compliance_requirements (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  label           text not null,
  policy_type     text not null check (policy_type in (
                    'general_liability', 'workers_compensation', 'commercial_auto',
                    'umbrella', 'professional_liability', 'pollution_liability',
                    'builders_risk'
                  )),
  -- Which vendor_policies numeric column this requirement is checked
  -- against. Only these two exist on vendor_policies today; widen this CHECK
  -- if a third limit field is ever added there.
  limit_field     text not null check (limit_field in ('each_occurrence_limit', 'general_aggregate_limit')),
  required_amount bigint not null check (required_amount >= 0),
  sort_order      smallint not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, label)
);

create index compliance_requirements_company_idx on public.compliance_requirements (company_id);

create trigger compliance_requirements_touch_updated_at
  before update on public.compliance_requirements
  for each row execute function public.touch_updated_at();

alter table public.compliance_requirements enable row level security;

create policy compliance_requirements_select on public.compliance_requirements
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy compliance_requirements_insert on public.compliance_requirements
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy compliance_requirements_update on public.compliance_requirements
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy compliance_requirements_delete on public.compliance_requirements
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));
