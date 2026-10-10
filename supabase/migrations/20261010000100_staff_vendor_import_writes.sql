-- Managed service: let VendorClr staff run a CSV vendor import on a customer's
-- behalf (bulk onboarding).
--
-- import_vendor_row() (20260917001500) already authorizes a platform admin -
-- its own check is `current_company_ids() OR is_platform_admin()` - and
-- audit_log_insert (20260902000900) already carries the is_platform_admin()
-- branch. The one remaining gap is the batch-summary row the import writes at
-- the end: vendor_import_batches_insert gates on can_write_company(), which a
-- staff account (a member of no company) never satisfies, so the whole import
-- fails on that final insert.
--
-- Widen it the same house-style way as the vendors/tasks and contacts writes
-- (`can_write_company(...) or is_platform_admin()`). can_write_company() stays
-- the members-only primitive. The client-side early refusal in
-- src/workflows/vendorImports.ts (assertCanWriteCompany) is relaxed in the same
-- change to allow platform admins through to this path.
--
-- Re-runnable. Applied to staging (ukbgjriqszthtgwxyirr) first for validation;
-- NOT yet applied to production.

alter policy vendor_import_batches_insert on public.vendor_import_batches
  with check (public.can_write_company(company_id) or public.is_platform_admin());
