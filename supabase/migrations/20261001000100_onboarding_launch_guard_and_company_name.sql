-- Onboarding safety hotfix: launch-readiness guard + company-name key backfill.
--
-- Two independent, re-runnable changes behind the P0/P1 onboarding fixes:
--
--   1. set_company_service_status() refuses to launch a workspace that is not
--      actually ready. Before this, staff (or a replayed request) could move any
--      company straight to 'live', including one still filling in the wizard,
--      opening a half-configured workspace. Launch now requires the company to be
--      in 'in_review' with a submitted onboarding row. Moves between
--      onboarding <-> in_review (e.g. a future "request changes") are unaffected.
--
--   2. Backfill company_onboarding.company_info from the legacy `name` key to
--      `companyName`, the key the wizard actually reads/writes. Rows provisioned
--      by self-checkout seeded `{ name }`, so the company name the buyer typed at
--      checkout never prefilled Step 1.
--
-- Applied to staging (ukbgjriqszthtgwxyirr) first; NOT applied to production by
-- this migration.

-- ---------------------------------------------------------------------------
-- 1. Launch-readiness guard
-- ---------------------------------------------------------------------------

create or replace function public.set_company_service_status(
  target_company uuid,
  next_status    text
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

  if next_status not in ('onboarding', 'in_review', 'live') then
    raise exception 'service_status must be onboarding, in_review or live'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.companies where id = target_company) then
    raise exception 'Company not found' using errcode = 'P0002';
  end if;

  -- Launching is a one-way, customer-visible transition, so it is gated: the
  -- company must have finished the wizard (service_status 'in_review' with a
  -- submitted onboarding row). This is the server-side half of the UI's disabled
  -- Launch button - the authoritative check, since the button is only an
  -- affordance.
  if next_status = 'live' then
    if not exists (
      select 1
      from public.companies c
      join public.company_onboarding o on o.company_id = c.id
      where c.id = target_company
        and c.service_status = 'in_review'
        and o.submitted_at is not null
    ) then
      raise exception
        'Workspace is not ready to launch: it must be submitted and awaiting review.'
        using errcode = '22023';
    end if;

    update public.company_onboarding
    set reviewed_at = coalesce(reviewed_at, now()),
        reviewed_by = coalesce(reviewed_by, admin_id),
        current_step = 7
    where company_id = target_company;
  end if;

  update public.companies
  set service_status = next_status
  where id = target_company
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (target_company, admin_id, 'service_activated', 'company', target_company,
          jsonb_build_object('service_status', next_status));

  return result;
end;
$fn$;

revoke execute on function public.set_company_service_status(uuid, text) from public, anon;
grant execute on function public.set_company_service_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. company_info name -> companyName backfill
-- ---------------------------------------------------------------------------
--
-- Only rows that carry a `name` but no usable `companyName` are touched; the key
-- is copied, `name` is left in place (harmless, and keeps the row readable by any
-- not-yet-redeployed code during rollout).

update public.company_onboarding
set company_info = company_info || jsonb_build_object('companyName', company_info->>'name')
where coalesce(nullif(company_info->>'name', ''), '') <> ''
  and coalesce(nullif(company_info->>'companyName', ''), '') = '';
