-- Staff account & company management.
--
-- Platform admins (VendorClr staff) can read every company's membership through
-- the is_platform_admin() branch on each SELECT policy, but there has never been
-- a WRITE path for them: company_members is writable only by a company owner
-- (has_company_role owner), platform_admins is "granted out of band via the
-- service role", and companies.plan is owner-only. So a staff operator could see
-- accounts but change nothing — the admin console's Access and Companies screens
-- were read-only tables.
--
-- These SECURITY DEFINER RPCs give staff an explicit, audited write path. Each
-- one re-checks is_platform_admin() itself (the function runs as its owner and
-- bypasses RLS, so the guard is the whole boundary) and raises 42501 otherwise,
-- exactly like request_company_changes() and the activation RPCs already do.
--
-- Safety rails encoded here, not just in the UI:
--   * a company always keeps at least one owner (no demoting/removing the last)
--   * a platform admin cannot revoke their own staff access (no self-lockout)
--
-- Re-runnable (create or replace). Applied to staging (ukbgjriqszthtgwxyirr)
-- first, then production (fzrcowwonezflydicpbd).

-- ---------------------------------------------------------------------------
-- Company membership: change a member's role
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_company_member_role(
  target_member uuid,
  new_role text
)
returns public.company_members
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  member   public.company_members;
  result   public.company_members;
  other_owners int;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if new_role not in ('owner', 'risk_manager', 'project_engineer', 'read_only') then
    raise exception 'Unknown role %', new_role using errcode = '22023';
  end if;

  select * into member from public.company_members where id = target_member;
  if member.id is null then
    raise exception 'Membership not found' using errcode = '22023';
  end if;

  -- Friendly pre-check; company_members_guard_last_owner_trg is the real guard
  -- and will abort this function if a demotion would leave zero active owners.
  if member.role = 'owner' and new_role <> 'owner' then
    select count(*) into other_owners
    from public.company_members
    where company_id = member.company_id and role = 'owner'
      and deactivated_at is null and id <> member.id;
    if other_owners = 0 then
      raise exception 'A company must keep at least one owner.' using errcode = '22023';
    end if;
  end if;

  update public.company_members
  set role = new_role
  where id = target_member
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (member.company_id, admin_id, 'member_role_changed', 'company_member', member.id,
          jsonb_build_object('from', member.role, 'to', new_role, 'user_id', member.user_id));

  return result;
end;
$fn$;

revoke execute on function public.admin_set_company_member_role(uuid, text) from public, anon;
grant execute on function public.admin_set_company_member_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Company membership: remove a member
-- ---------------------------------------------------------------------------
-- Soft-deactivate, matching the owner-facing remove_company_member() in
-- 20260916000500 (seat_count and the directory both read deactivated_at),
-- rather than a hard delete that would lose the row and its history.
create or replace function public.admin_remove_company_member(target_member uuid)
returns public.company_members
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  member   public.company_members;
  result   public.company_members;
  other_owners int;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into member from public.company_members where id = target_member;
  if member.id is null then
    raise exception 'Membership not found' using errcode = '22023';
  end if;
  if member.deactivated_at is not null then
    raise exception 'This member has already been removed.' using errcode = '22023';
  end if;

  -- Friendly pre-check; company_members_guard_last_owner_trg is the real guard.
  if member.role = 'owner' then
    select count(*) into other_owners
    from public.company_members
    where company_id = member.company_id and role = 'owner'
      and deactivated_at is null and id <> member.id;
    if other_owners = 0 then
      raise exception 'A company must keep at least one owner.' using errcode = '22023';
    end if;
  end if;

  update public.company_members
  set deactivated_at = now(), deactivated_by = admin_id
  where id = target_member
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (member.company_id, admin_id, 'member_removed', 'company_member', member.id,
          jsonb_build_object('role', member.role, 'user_id', member.user_id));

  return result;
end;
$fn$;

revoke execute on function public.admin_remove_company_member(uuid) from public, anon;
grant execute on function public.admin_remove_company_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Platform admin (super admin / staff) grant and revoke
-- ---------------------------------------------------------------------------
-- Not written to audit_log: that table is company-scoped (company_id NOT NULL)
-- and staff membership is global. platform_admins.created_at is the trail.
create or replace function public.admin_set_platform_admin(
  target_user uuid,
  enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if not enabled and target_user = (select auth.uid()) then
    raise exception 'You cannot revoke your own super-admin access.' using errcode = '22023';
  end if;

  if enabled then
    -- FK to auth.users rejects an unknown id, so an invalid target fails loudly.
    insert into public.platform_admins (user_id)
    values (target_user)
    on conflict (user_id) do nothing;
  else
    delete from public.platform_admins where user_id = target_user;
  end if;
end;
$fn$;

revoke execute on function public.admin_set_platform_admin(uuid, boolean) from public, anon;
grant execute on function public.admin_set_platform_admin(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Company plan
-- ---------------------------------------------------------------------------
create or replace function public.set_company_plan(
  target_company uuid,
  new_plan text
)
returns public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  result   public.companies;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Matches companies_plan_check after the self-checkout migration
  -- (20260929000100): the PlanId vocabulary, not the original Field/Program set.
  if new_plan not in ('core', 'operations', 'scale', 'enterprise') then
    raise exception 'Unknown plan %', new_plan using errcode = '22023';
  end if;

  update public.companies
  set plan = new_plan
  where id = target_company
  returning * into result;

  if result.id is null then
    raise exception 'Company not found' using errcode = '22023';
  end if;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (target_company, admin_id, 'subscription_updated', 'company', target_company,
          jsonb_build_object('plan', new_plan));

  return result;
end;
$fn$;

revoke execute on function public.set_company_plan(uuid, text) from public, anon;
grant execute on function public.set_company_plan(uuid, text) to authenticated;
