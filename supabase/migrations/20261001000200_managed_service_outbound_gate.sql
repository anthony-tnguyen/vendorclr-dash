-- Server-side managed-service gate on outbound vendor requests.
--
-- A paid workspace that is still onboarding / in review must not send to vendors:
-- VendorClr has not validated the setup or turned on managed service. Every
-- outbound path (the ad-hoc "request documents" action, the CSV importer's
-- dispatch, and the renewal-reminder cron) creates a vendor_upload_requests row,
-- so a single BEFORE INSERT trigger there is the authoritative gate — the UI's
-- disabled controls are only an affordance.
--
-- Companies reach 'live' via staff launch (set_company_service_status) or the
-- activation-code path (redeem creates 'live'); pre-existing activated companies
-- were backfilled to 'live' by 20260929000100. So this only bites workspaces that
-- genuinely have not launched yet.
--
-- Re-runnable. Applied to staging (ukbgjriqszthtgwxyirr) first; NOT applied to
-- production by this migration.

create or replace function public.enforce_service_live_for_requests()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not exists (
    select 1 from public.companies c
    where c.id = new.company_id and c.service_status = 'live'
  ) then
    raise exception
      'Managed service is not live for this workspace yet, so vendor requests are held until launch.'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists vendor_upload_requests_require_live on public.vendor_upload_requests;
create trigger vendor_upload_requests_require_live
  before insert on public.vendor_upload_requests
  for each row execute function public.enforce_service_live_for_requests();
