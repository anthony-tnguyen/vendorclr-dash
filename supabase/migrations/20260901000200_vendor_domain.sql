-- Phase 0 / migration 2 - the vendor domain.
--
-- The headline change against src/data/contracts.ts: a vendor no longer owns a
-- single flat (policy_number, expires_on) pair. Policies are their own rows, so a
-- sub can carry GL + WC + Auto + Umbrella with different carriers and dates.
-- The repository still projects a primary policy onto Vendor.policyNumber /
-- Vendor.expiresOn so the existing UI keeps working unchanged.
--
-- Money columns are bigint whole dollars. numeric would be more precise but
-- PostgREST serialises numeric as a JSON *string* to protect precision, which
-- would break the Intl.NumberFormat calls in the UI. int8 serialises as a number.

-- ---------------------------------------------------------------------------
-- vendors
-- ---------------------------------------------------------------------------

create table public.vendors (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 200),
  -- Display strings, matching the VendorTrade union in contracts.ts 1:1 so Phase 0
  -- needs no mapping layer. Phase 1 should move these to a lookup table before
  -- trade filtering or localisation lands.
  trade          text not null check (trade in (
                   'Structural Steel', 'Electrical', 'Mechanical / HVAC', 'Concrete',
                   'Earthwork', 'Roofing', 'Glazing', 'Fire Protection'
                 )),
  project        text not null default 'Unassigned',
  contract_value bigint not null default 0 check (contract_value >= 0),
  contact_name   text not null default '',
  contact_email  text not null default '' check (contact_email = '' or position('@' in contact_email) > 1),
  risk_tier      text not null default 'moderate' check (risk_tier in ('low', 'moderate', 'high')),
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index vendors_company_id_idx on public.vendors (company_id);
create index vendors_company_active_idx on public.vendors (company_id, created_at desc)
  where archived_at is null;

-- ---------------------------------------------------------------------------
-- vendor_policies
-- ---------------------------------------------------------------------------

create table public.vendor_policies (
  id                    uuid primary key default gen_random_uuid(),
  -- Denormalised from vendors purely so RLS is one indexed predicate.
  -- Kept honest by the vendor_policies_company_matches_vendor trigger below.
  company_id            uuid not null references public.companies (id) on delete cascade,
  vendor_id             uuid not null references public.vendors (id) on delete cascade,
  policy_type           text not null check (policy_type in (
                          'general_liability', 'workers_compensation', 'commercial_auto',
                          'umbrella', 'professional_liability', 'pollution_liability',
                          'builders_risk'
                        )),
  carrier_name          text not null default '',
  policy_number         text not null default '',
  effective_date        date,
  expiration_date       date,

  each_occurrence_limit bigint check (each_occurrence_limit >= 0),
  general_aggregate_limit bigint check (general_aggregate_limit >= 0),

  -- Tri-state on purpose. NULL means "not yet determined", which is materially
  -- different from false ("determined absent"). Phase 2 extraction depends on
  -- being able to say it does not know.
  additional_insured      boolean,
  waiver_of_subrogation   boolean,
  primary_noncontributory boolean,

  status              text not null default 'active'
                        check (status in ('active', 'expired', 'superseded', 'cancelled')),
  verification_status text not null default 'unverified'
                        check (verification_status in ('unverified', 'needs_review', 'verified', 'rejected')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (effective_date is null or expiration_date is null or expiration_date >= effective_date)
);

create index vendor_policies_vendor_idx on public.vendor_policies (vendor_id);
create index vendor_policies_company_idx on public.vendor_policies (company_id);
create index vendor_policies_expiration_idx on public.vendor_policies (company_id, expiration_date)
  where status = 'active';

-- Only one active policy per vendor per coverage type. Renewals supersede rather
-- than duplicate, which is what makes "the current GL policy" a well-defined thing.
create unique index vendor_policies_one_active_per_type
  on public.vendor_policies (vendor_id, policy_type)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- vendor_compliance_items - the five-segment compliance rail
-- ---------------------------------------------------------------------------

create table public.vendor_compliance_items (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  vendor_id       uuid not null references public.vendors (id) on delete cascade,
  requirement_key text not null check (requirement_key in (
                    'coi', 'additionalInsured', 'waiverOfSubrogation', 'lienWaiver', 'renewal'
                  )),
  status          text not null default 'missing'
                    check (status in ('compliant', 'expiring', 'missing', 'expired', 'pending')),
  effective_date  date,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vendor_id, requirement_key)
);

create index vendor_compliance_items_vendor_idx on public.vendor_compliance_items (vendor_id);
create index vendor_compliance_items_company_idx on public.vendor_compliance_items (company_id);

-- ---------------------------------------------------------------------------
-- vendor_coverage_limits - required vs carried
-- ---------------------------------------------------------------------------

-- Phase 1 note: `required_amount` genuinely belongs on a per-company
-- compliance_requirements table and `carried_amount` on vendor_policies. They are
-- co-located here only because the current CoverageLimit contract pairs them.
create table public.vendor_coverage_limits (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  vendor_id       uuid not null references public.vendors (id) on delete cascade,
  label           text not null,
  required_amount bigint not null default 0 check (required_amount >= 0),
  carried_amount  bigint not null default 0 check (carried_amount >= 0),
  sort_order      smallint not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vendor_id, label)
);

create index vendor_coverage_limits_vendor_idx on public.vendor_coverage_limits (vendor_id);

-- ---------------------------------------------------------------------------
-- Integrity: child company_id must equal the parent vendor's company_id
-- ---------------------------------------------------------------------------

-- Without this, a caller who can write to company A could attach a row carrying
-- company_id = A to a vendor owned by company B. Both the INSERT policy and the
-- FK would pass; only this check catches it.
create or replace function public.assert_company_matches_vendor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  select company_id into owner_company from public.vendors where id = new.vendor_id;

  if owner_company is null then
    raise exception 'vendor % does not exist', new.vendor_id using errcode = '23503';
  end if;

  if owner_company <> new.company_id then
    raise exception 'company_id % does not match the owning company % of vendor %',
      new.company_id, owner_company, new.vendor_id using errcode = '23514';
  end if;

  return new;
end;
$fn$;

create trigger vendor_policies_company_matches_vendor
  before insert or update on public.vendor_policies
  for each row execute function public.assert_company_matches_vendor();

create trigger vendor_compliance_items_company_matches_vendor
  before insert or update on public.vendor_compliance_items
  for each row execute function public.assert_company_matches_vendor();

create trigger vendor_coverage_limits_company_matches_vendor
  before insert or update on public.vendor_coverage_limits
  for each row execute function public.assert_company_matches_vendor();

-- updated_at
create trigger vendors_touch_updated_at
  before update on public.vendors
  for each row execute function public.touch_updated_at();

create trigger vendor_policies_touch_updated_at
  before update on public.vendor_policies
  for each row execute function public.touch_updated_at();

create trigger vendor_compliance_items_touch_updated_at
  before update on public.vendor_compliance_items
  for each row execute function public.touch_updated_at();

create trigger vendor_coverage_limits_touch_updated_at
  before update on public.vendor_coverage_limits
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- New vendors start fully non-compliant
-- ---------------------------------------------------------------------------

-- Mirrors createVendor() in demoRepository.ts, and encodes the rule the earlier
-- review was reaching for: nothing is compliant until something proves it is.
create or replace function public.seed_vendor_compliance_items()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.vendor_compliance_items (company_id, vendor_id, requirement_key, status)
  select new.company_id, new.id, k.req_key, 'missing'
  from unnest(array['coi', 'additionalInsured', 'waiverOfSubrogation', 'lienWaiver', 'renewal'])
    as k(req_key)
  on conflict (vendor_id, requirement_key) do nothing;
  return new;
end;
$fn$;

create trigger vendors_seed_compliance_items
  after insert on public.vendors
  for each row execute function public.seed_vendor_compliance_items();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.vendors                 enable row level security;
alter table public.vendor_policies         enable row level security;
alter table public.vendor_compliance_items enable row level security;
alter table public.vendor_coverage_limits  enable row level security;

-- Read: any member of the owning company. Write: members with a write role.
-- Platform admins can read but deliberately cannot write customer records.
--
-- Written out per table rather than generated in a loop. RLS is the security
-- boundary; it should be greppable and reviewable line by line.

-- vendors --------------------------------------------------------------------
create policy vendors_select on public.vendors
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy vendors_insert on public.vendors
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy vendors_update on public.vendors
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy vendors_delete on public.vendors
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- vendor_policies ------------------------------------------------------------
create policy vendor_policies_select on public.vendor_policies
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy vendor_policies_insert on public.vendor_policies
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy vendor_policies_update on public.vendor_policies
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy vendor_policies_delete on public.vendor_policies
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- vendor_compliance_items ----------------------------------------------------
create policy vendor_compliance_items_select on public.vendor_compliance_items
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy vendor_compliance_items_insert on public.vendor_compliance_items
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy vendor_compliance_items_update on public.vendor_compliance_items
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy vendor_compliance_items_delete on public.vendor_compliance_items
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- vendor_coverage_limits -----------------------------------------------------
create policy vendor_coverage_limits_select on public.vendor_coverage_limits
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy vendor_coverage_limits_insert on public.vendor_coverage_limits
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy vendor_coverage_limits_update on public.vendor_coverage_limits
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy vendor_coverage_limits_delete on public.vendor_coverage_limits
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));
