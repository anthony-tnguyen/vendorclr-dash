-- Fixes company_vendor_usage()'s membership check.
--
-- The original definition (20260929000100_self_checkout_billing_and_onboarding.sql)
-- guarded the function with:
--
--     target_company in (select company_id from public.current_company_ids())
--
-- but current_company_ids() returns `setof uuid` - a set of bare UUID values,
-- not a row with a `company_id` column. Selecting a non-existent column raises
--
--     42703 column "company_id" does not exist
--
-- at runtime, so every authorized call failed and the UI silently rendered
-- nothing (the React Query error was ignored). Every RLS policy in the schema
-- already uses the correct form - `in (select public.current_company_ids())` -
-- this brings the function in line with it.
--
-- create or replace preserves the existing EXECUTE grants; they are re-asserted
-- below so this migration is self-contained and idempotent in an environment
-- where the function was never created by the original migration.

create or replace function public.company_vendor_usage(target_company uuid)
returns table (active_vendors integer, max_active_vendors integer, utilization numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  ceiling integer;
  used    integer;
begin
  if not (
    target_company in (select public.current_company_ids())
    or public.is_platform_admin()
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select pl.max_active_vendors into ceiling
  from public.companies c
  left join public.plan_limits pl on pl.plan = c.plan
  where c.id = target_company;

  select count(*)::int into used
  from public.vendors
  where company_id = target_company and archived_at is null;

  return query select
    used,
    ceiling,
    case when ceiling is null or ceiling = 0 then 0::numeric
         else round(used::numeric / ceiling, 4) end;
end;
$fn$;

revoke execute on function public.company_vendor_usage(uuid) from public, anon;
grant execute on function public.company_vendor_usage(uuid) to authenticated;
