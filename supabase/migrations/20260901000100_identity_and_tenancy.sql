-- Phase 0 / migration 1 - identity, tenancy and the RLS primitives everything else builds on.
--
-- Design notes:
--   * Every tenant-scoped table carries company_id directly. Denormalising it onto
--     child tables (instead of joining up through vendors) keeps RLS policies to a
--     single indexed predicate and avoids recursive policy evaluation.
--   * Membership lookups go through SECURITY DEFINER helpers. A policy on
--     company_members that queried company_members directly would recurse; the
--     helper bypasses RLS and breaks the cycle.
--   * auth.uid() is wrapped in a scalar subquery throughout. Postgres then treats
--     it as an InitPlan and evaluates it once per statement rather than per row.

-- No pgcrypto needed: gen_random_uuid() has been in core Postgres since 13, and
-- the only other hash used here is core md5() in a view.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application-visible mirror of auth.users. Populated by the on_auth_user_created trigger.';

create table public.companies (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(btrim(name)) between 1 and 200),
  plan                   text not null default 'Field' check (plan in ('Field', 'Program', 'Enterprise')),
  subscription_renews_on date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Roles mirror the AccessGrant["role"] union in src/data/contracts.ts.
-- Stored snake_case; the repository maps to the display labels the UI expects.
create table public.company_members (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  role           text not null check (role in ('owner', 'risk_manager', 'project_engineer', 'read_only')),
  scope          text not null default 'All projects',
  last_active_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_members_user_id_idx on public.company_members (user_id);
create index company_members_company_id_idx on public.company_members (company_id);

-- VendorClear staff. Deliberately a table rather than a JWT claim so access can be
-- revoked immediately instead of at the next token refresh.
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger companies_touch_updated_at
  before update on public.companies
  for each row execute function public.touch_updated_at();

create trigger company_members_touch_updated_at
  before update on public.company_members
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Profile provisioning
-- ---------------------------------------------------------------------------

-- Creates the profile, and the company when signup supplied one.
--
-- Company creation lives here rather than in a client call after signUp() because
-- with email confirmation enabled there is no session immediately after signup -
-- the client has no authenticated context to create anything with. Doing it on the
-- auth.users insert means the company exists whenever the user first signs in.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  requested_company text := nullif(
    btrim(coalesce(new.raw_user_meta_data ->> 'company_name', '')), ''
  );
  new_company uuid;
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  if requested_company is not null then
    insert into public.companies (name)
    values (left(requested_company, 200))
    returning id into new_company;

    insert into public.company_members (company_id, user_id, role, last_active_at)
    values (new_company, new.id, 'owner', now())
    on conflict (company_id, user_id) do nothing;
  end if;

  return new;
end;
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS primitives
-- ---------------------------------------------------------------------------

-- Companies the caller belongs to. SECURITY DEFINER so it can read
-- company_members without re-entering that table's own policies.
create or replace function public.current_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select company_id
  from public.company_members
  where user_id = (select auth.uid());
$fn$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.platform_admins where user_id = (select auth.uid())
  );
$fn$;

-- Write authority within one company. read_only members are never included.
create or replace function public.has_company_role(target_company uuid, allowed text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
    from public.company_members
    where user_id = (select auth.uid())
      and company_id = target_company
      and role = any (allowed)
  );
$fn$;

create or replace function public.can_write_company(target_company uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$
  select public.has_company_role(target_company, array['owner', 'risk_manager', 'project_engineer']);
$fn$;

create or replace function public.shares_company_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
    from public.company_members m
    where m.user_id = target_user
      and m.company_id in (select public.current_company_ids())
  );
$fn$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.companies       enable row level security;
alter table public.company_members enable row level security;
alter table public.platform_admins enable row level security;

-- profiles ------------------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.shares_company_with(id)
    or public.is_platform_admin()
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- companies -----------------------------------------------------------------
create policy companies_select on public.companies
  for select to authenticated
  using (id in (select public.current_company_ids()) or public.is_platform_admin());

create policy companies_update on public.companies
  for update to authenticated
  using (public.has_company_role(id, array['owner']))
  with check (public.has_company_role(id, array['owner']));

-- No INSERT policy on purpose: companies are created only through
-- create_company_for_current_user(), which also writes the owner membership.
-- A bare INSERT would otherwise leave an orphaned, unreachable company.

-- company_members -----------------------------------------------------------
create policy company_members_select on public.company_members
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy company_members_insert on public.company_members
  for insert to authenticated
  with check (public.has_company_role(company_id, array['owner']));

create policy company_members_update on public.company_members
  for update to authenticated
  using (public.has_company_role(company_id, array['owner']))
  with check (public.has_company_role(company_id, array['owner']));

create policy company_members_delete on public.company_members
  for delete to authenticated
  using (public.has_company_role(company_id, array['owner']));

-- platform_admins -----------------------------------------------------------
-- Readable only by staff; membership is granted out of band via the service role.
create policy platform_admins_select on public.platform_admins
  for select to authenticated
  using (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Onboarding RPC
-- ---------------------------------------------------------------------------

-- A brand new user belongs to no company, so RLS would reject a direct INSERT
-- into companies. This runs as definer and creates company + owner membership
-- atomically.
create or replace function public.create_company_for_current_user(
  company_name text,
  member_name  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller      uuid := (select auth.uid());
  new_company uuid;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if length(btrim(coalesce(company_name, ''))) = 0 then
    raise exception 'company_name is required' using errcode = '22023';
  end if;

  insert into public.companies (name)
  values (btrim(company_name))
  returning id into new_company;

  insert into public.company_members (company_id, user_id, role, last_active_at)
  values (new_company, caller, 'owner', now());

  if nullif(btrim(coalesce(member_name, '')), '') is not null then
    update public.profiles set full_name = btrim(member_name) where id = caller;
  end if;

  return new_company;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

-- Postgres grants EXECUTE to PUBLIC by default, and `anon` inherits it. Revoking
-- from `anon` alone would leave that PUBLIC grant in place and change nothing, so
-- every SECURITY DEFINER helper is revoked from PUBLIC first and then granted
-- explicitly. These functions read membership with RLS bypassed; an anonymous
-- caller must not be able to invoke them at all.
revoke execute on function public.current_company_ids() from public;
revoke execute on function public.is_platform_admin() from public;
revoke execute on function public.has_company_role(uuid, text[]) from public;
revoke execute on function public.can_write_company(uuid) from public;
revoke execute on function public.shares_company_with(uuid) from public;
revoke execute on function public.create_company_for_current_user(text, text) from public;

grant execute on function public.current_company_ids() to authenticated;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.has_company_role(uuid, text[]) to authenticated;
grant execute on function public.can_write_company(uuid) to authenticated;
grant execute on function public.shares_company_with(uuid) to authenticated;
grant execute on function public.create_company_for_current_user(text, text) to authenticated;
