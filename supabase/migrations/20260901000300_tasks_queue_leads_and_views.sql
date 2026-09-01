-- Phase 0 / migration 3 - the remaining tables the current UI reads, plus the
-- aggregate views behind the reports and admin screens.
--
-- compliance_queue_items is a real table here so the admin screen has something to
-- read. Phase 2 should derive it from document_processing_jobs instead and drop it.

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------

create table public.tasks (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Nullable: some follow-ups are program-level rather than about one vendor.
  vendor_id  uuid references public.vendors (id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 300),
  due_on     date,
  priority   text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status     text not null default 'open' check (status in ('open', 'waiting', 'done')),
  -- Free text for Phase 0. Becomes a company_members reference once assignment is real.
  owner      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_company_idx on public.tasks (company_id, status, due_on);
create index tasks_vendor_idx on public.tasks (vendor_id);

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- tasks.vendor_id is nullable, so the shared assert trigger (which requires a
-- vendor) does not fit. This variant permits a null vendor.
create or replace function public.assert_task_company_matches_vendor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  if new.vendor_id is null then
    return new;
  end if;

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

create trigger tasks_company_matches_vendor
  before insert or update on public.tasks
  for each row execute function public.assert_task_company_matches_vendor();

-- ---------------------------------------------------------------------------
-- compliance_queue_items - platform-side document review
-- ---------------------------------------------------------------------------

create table public.compliance_queue_items (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  document_label text not null,
  submitted_on   date not null default current_date,
  state          text not null default 'queued' check (state in ('queued', 'in-review', 'escalated')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index compliance_queue_items_state_idx on public.compliance_queue_items (state, submitted_on);
create index compliance_queue_items_company_idx on public.compliance_queue_items (company_id);

create trigger compliance_queue_items_touch_updated_at
  before update on public.compliance_queue_items
  for each row execute function public.touch_updated_at();

create trigger compliance_queue_items_company_matches_vendor
  before insert or update on public.compliance_queue_items
  for each row execute function public.assert_company_matches_vendor();

-- ---------------------------------------------------------------------------
-- leads - VendorClear's own pipeline, not customer data
-- ---------------------------------------------------------------------------

create table public.leads (
  id           uuid primary key default gen_random_uuid(),
  company_name text not null,
  contact_name text not null default '',
  trade        text not null default '',
  source       text not null default '',
  stage        text not null default 'new' check (stage in ('new', 'qualified', 'demo', 'closed')),
  created_on   date not null default current_date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.tasks                  enable row level security;
alter table public.compliance_queue_items enable row level security;
alter table public.leads                  enable row level security;

-- tasks ----------------------------------------------------------------------
create policy tasks_select on public.tasks
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy tasks_update on public.tasks
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy tasks_delete on public.tasks
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner', 'risk_manager']));

-- compliance_queue_items -----------------------------------------------------
-- The customer can watch their own submissions; only staff change review state.
create policy compliance_queue_items_select on public.compliance_queue_items
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy compliance_queue_items_write on public.compliance_queue_items
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- leads ----------------------------------------------------------------------
-- Staff only, in every direction. This is not customer-visible data.
create policy leads_staff_only on public.leads
  for all to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Aggregate views
-- ---------------------------------------------------------------------------

-- security_invoker is essential. Without it a view runs with its owner's rights
-- and silently bypasses the RLS on every table underneath it.

-- One row per vendor with its rolled-up compliance state.
--
-- Scalar subqueries rather than two LEFT JOINs on purpose: joining both
-- vendor_compliance_items (5 rows) and vendor_policies (N rows) to the same vendor
-- produces a cartesian product, and every aggregate over it comes out multiplied.
create view public.vendor_compliance_summary
with (security_invoker = true) as
select
  v.id as vendor_id,
  v.company_id,
  v.project,
  (
    select count(*)::int
    from public.vendor_compliance_items ci
    where ci.vendor_id = v.id and ci.status <> 'compliant'
  ) as open_exceptions,
  (
    -- bool_and over zero rows is NULL; a vendor with no requirements on file is
    -- not compliant, so collapse that to false.
    select coalesce(bool_and(ci.status = 'compliant'), false)
    from public.vendor_compliance_items ci
    where ci.vendor_id = v.id
  ) as fully_compliant,
  (
    select min(p.expiration_date)
    from public.vendor_policies p
    where p.vendor_id = v.id and p.status = 'active'
  ) as next_expiration
from public.vendors v
where v.archived_at is null;

-- Backs ReportsPage: one row per project.
create view public.company_report_rows
with (security_invoker = true) as
select
  md5(s.company_id::text || ':' || s.project) as id,
  s.company_id,
  s.project,
  count(*)::int                               as vendors,
  coalesce(
    round(100.0 * count(*) filter (where s.fully_compliant) / nullif(count(*), 0)),
    0
  )::int                                      as compliant_pct,
  count(*) filter (
    where s.next_expiration is not null
      and s.next_expiration between current_date and current_date + 30
  )::int                                      as expiring_in_30,
  coalesce(sum(s.open_exceptions), 0)::int    as open_exceptions
from public.vendor_compliance_summary s
group by s.company_id, s.project;

-- Backs the admin Companies screen.
create view public.admin_company_stats
with (security_invoker = true) as
select
  c.id,
  c.name,
  c.plan,
  c.subscription_renews_on,
  (select count(*) from public.vendors v
    where v.company_id = c.id and v.archived_at is null)::int as vendor_count,
  (select count(*) from public.company_members m
    where m.company_id = c.id)::int                           as seat_count,
  coalesce((
    select round(100.0 * count(*) filter (where s.fully_compliant) / nullif(count(*), 0))
    from public.vendor_compliance_summary s
    where s.company_id = c.id
  ), 0)::int                                                  as compliance_rate
from public.companies c;
