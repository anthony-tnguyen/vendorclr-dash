-- Let VendorClr staff (platform_admins) manage a customer's contacts.
--
-- The contacts / vendor_contacts / suppressed_recipients SELECT policies
-- already admit is_platform_admin() (migration 20260916000600), so staff can
-- see a customer's contacts, but every write policy gates on can_write_company()
-- alone - which only covers a company's own owner/risk_manager/project_engineer
-- members and never a platform admin. That left staff unable to add, edit,
-- re-role, unlink or (un)suppress contacts on a customer's behalf, which the
-- console now lets them do from the vendor detail page.
--
-- Widen each write policy to `can_write_company(company_id) or
-- is_platform_admin()`, matching the SELECT policies' shape. The cross-tenant
-- assert_company_matches_vendor() trigger still runs on vendor_contacts, so a
-- staff write still cannot attach a contact carrying the wrong company_id to a
-- vendor. Company members' access is unchanged.

-- contacts ------------------------------------------------------------------
drop policy contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert to authenticated
  with check (public.can_write_company(company_id) or public.is_platform_admin());

drop policy contacts_update on public.contacts;
create policy contacts_update on public.contacts
  for update to authenticated
  using (public.can_write_company(company_id) or public.is_platform_admin())
  with check (public.can_write_company(company_id) or public.is_platform_admin());

drop policy contacts_delete on public.contacts;
create policy contacts_delete on public.contacts
  for delete to authenticated
  using (public.can_write_company(company_id) or public.is_platform_admin());

-- vendor_contacts -----------------------------------------------------------
drop policy vendor_contacts_insert on public.vendor_contacts;
create policy vendor_contacts_insert on public.vendor_contacts
  for insert to authenticated
  with check (public.can_write_company(company_id) or public.is_platform_admin());

drop policy vendor_contacts_update on public.vendor_contacts;
create policy vendor_contacts_update on public.vendor_contacts
  for update to authenticated
  using (public.can_write_company(company_id) or public.is_platform_admin())
  with check (public.can_write_company(company_id) or public.is_platform_admin());

drop policy vendor_contacts_delete on public.vendor_contacts;
create policy vendor_contacts_delete on public.vendor_contacts
  for delete to authenticated
  using (public.can_write_company(company_id) or public.is_platform_admin());

-- suppressed_recipients -----------------------------------------------------
-- The contacts panel's "Mark do-not-email" / "Clear suppression" controls
-- write here, so staff need the same widening to use them on a customer's
-- behalf. The bounce webhook's handle_bounce_suppression() is SECURITY DEFINER
-- and bypasses these policies regardless, so its automatic writes are
-- unaffected.
drop policy suppressed_recipients_insert on public.suppressed_recipients;
create policy suppressed_recipients_insert on public.suppressed_recipients
  for insert to authenticated
  with check (public.can_write_company(company_id) or public.is_platform_admin());

drop policy suppressed_recipients_update on public.suppressed_recipients;
create policy suppressed_recipients_update on public.suppressed_recipients
  for update to authenticated
  using (public.can_write_company(company_id) or public.is_platform_admin())
  with check (public.can_write_company(company_id) or public.is_platform_admin());

drop policy suppressed_recipients_delete on public.suppressed_recipients;
create policy suppressed_recipients_delete on public.suppressed_recipients
  for delete to authenticated
  using (public.can_write_company(company_id) or public.is_platform_admin());
