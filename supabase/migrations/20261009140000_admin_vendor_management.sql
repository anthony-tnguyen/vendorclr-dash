-- Managed service: let staff add a vendor on a customer company's behalf.
--
-- vendors_select already exposes every company's vendors to a platform admin
-- (is_platform_admin() branch), so staff can already read a customer's roster.
-- Writes are the gap: vendors_insert is `can_write_company(company_id)`, which a
-- staff account - a member of no company - never satisfies.
--
-- Rather than widen vendors_insert to all platform admins (a blanket write grant
-- across every company), this is a single SECURITY DEFINER RPC that names the
-- target company explicitly and re-checks is_platform_admin() itself. The
-- existing after-insert triggers (seed_vendor_compliance_items,
-- ensure_vendor_operational_contact) fire exactly as they do for a customer
-- insert, so a staff-created vendor starts with the same five compliance rows.
--
-- Re-runnable. Applied to staging (ukbgjriqszthtgwxyirr), then production
-- (fzrcowwonezflydicpbd).

create or replace function public.admin_create_vendor(
  target_company uuid,
  vendor_name text,
  vendor_trade text,
  vendor_project text default 'Unassigned',
  vendor_contract_value bigint default 0,
  vendor_contact_name text default '',
  vendor_contact_email text default ''
)
returns public.vendors
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  result public.vendors;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if not exists (select 1 from public.companies where id = target_company) then
    raise exception 'Company not found' using errcode = '22023';
  end if;

  -- name/trade/contact_email are validated by the table's own CHECK constraints,
  -- which raise here if violated (e.g. an unknown trade or a malformed email).
  insert into public.vendors (
    company_id, name, trade, project, contract_value, contact_name, contact_email
  )
  values (
    target_company,
    vendor_name,
    vendor_trade,
    coalesce(nullif(btrim(vendor_project), ''), 'Unassigned'),
    greatest(0, coalesce(vendor_contract_value, 0)),
    coalesce(vendor_contact_name, ''),
    coalesce(vendor_contact_email, '')
  )
  returning * into result;

  return result;
end;
$fn$;

revoke execute on function
  public.admin_create_vendor(uuid, text, text, text, bigint, text, text) from public, anon;
grant execute on function
  public.admin_create_vendor(uuid, text, text, text, bigint, text, text) to authenticated;
