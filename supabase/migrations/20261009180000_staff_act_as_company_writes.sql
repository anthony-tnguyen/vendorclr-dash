-- "Act as company": let VendorClr staff write a customer's vendors and tasks.
--
-- When staff enter a company's console (the acting-company context), the
-- customer vendor and task flows write as the signed-in staff member. Those
-- write policies gate on can_write_company() alone, which a platform admin
-- never satisfies. Widen them the same way 20261009000100 (contacts) and
-- 20261009160000 (upload requests) did: `can_write_company(...) or
-- is_platform_admin()`. can_write_company() stays the members-only primitive.
--
-- Scoped to the two tables the acting console currently exposes (Vendors and
-- Tasks). Projects, requirement profiles and settings are not yet acting-aware
-- and are hidden from the acting nav, so their write policies are intentionally
-- left unchanged here.
--
-- Applied to staging (ukbgjriqszthtgwxyirr) first for validation; NOT yet
-- applied to production.

-- vendors --------------------------------------------------------------------
alter policy vendors_insert on public.vendors
  with check (public.can_write_company(company_id) or public.is_platform_admin());

alter policy vendors_update on public.vendors
  using (public.can_write_company(company_id) or public.is_platform_admin())
  with check (public.can_write_company(company_id) or public.is_platform_admin());

alter policy vendors_delete on public.vendors
  using (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );

-- tasks ----------------------------------------------------------------------
alter policy tasks_insert on public.tasks
  with check (public.can_write_company(company_id) or public.is_platform_admin());

alter policy tasks_update on public.tasks
  using (public.can_write_company(company_id) or public.is_platform_admin())
  with check (public.can_write_company(company_id) or public.is_platform_admin());

alter policy tasks_delete on public.tasks
  using (
    public.has_company_role(company_id, array['owner', 'risk_manager'])
    or public.is_platform_admin()
  );
