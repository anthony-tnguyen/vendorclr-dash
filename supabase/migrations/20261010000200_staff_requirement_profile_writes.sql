-- "Act as company": let VendorClr staff configure a customer's requirement
-- profiles and their rules (the compliance rules the managed service maintains
-- on the customer's behalf).
--
-- The requirement_profiles / requirement_profile_rules write policies gate on
-- has_company_role(owner/risk_manager), which a platform admin never satisfies,
-- and set_company_default_requirement_profile() re-checks the same role. The
-- RequirementProfilesPage already reads company-scoped and treats an acting
-- staff member as an owner, so only the writes are the gap.
--
-- Widen the six write policies and the default-profile RPC with
-- `... or is_platform_admin()`, the same house style as the vendors/tasks
-- (20261009180000) and contacts (20261009000100) writes. has_company_role()
-- stays the members-only primitive.
--
-- Re-runnable. Applied to staging (ukbgjriqszthtgwxyirr) first for validation;
-- NOT yet applied to production.

-- requirement_profiles --------------------------------------------------------
alter policy requirement_profiles_insert on public.requirement_profiles
  with check (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );

alter policy requirement_profiles_update on public.requirement_profiles
  using (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  )
  with check (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );

alter policy requirement_profiles_delete on public.requirement_profiles
  using (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );

-- requirement_profile_rules ---------------------------------------------------
alter policy requirement_profile_rules_insert on public.requirement_profile_rules
  with check (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );

alter policy requirement_profile_rules_update on public.requirement_profile_rules
  using (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  )
  with check (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );

alter policy requirement_profile_rules_delete on public.requirement_profile_rules
  using (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );

-- set_company_default_requirement_profile() -----------------------------------
-- Same body as 20260922061822, with the authorization check widened to admit a
-- platform admin acting on the company's behalf.
create or replace function public.set_company_default_requirement_profile(profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  profile_company_id uuid;
begin
  select company_id into profile_company_id
  from public.requirement_profiles
  where id = profile_id and archived_at is null;

  if profile_company_id is null
    or not (
      public.has_company_role(profile_company_id, array['owner', 'risk_manager'])
      or public.is_platform_admin()
    ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.requirement_profiles
  set is_company_default = (id = profile_id)
  where company_id = profile_company_id
    and is_company_default is distinct from (id = profile_id);
end;
$fn$;

revoke execute on function public.set_company_default_requirement_profile(uuid) from public, anon;
grant execute on function public.set_company_default_requirement_profile(uuid) to authenticated;
