-- ---------------------------------------------------------------------------
-- email_outbox - record company-invitation sends
-- ---------------------------------------------------------------------------
--
-- inviteCompanyMember()/resendCompanyInvitation() (src/workflows/
-- companyInvitations.ts) have always inserted an email_outbox row with
-- template = 'company_invitation' and no vendor_id. Neither insert could ever
-- succeed: vendor_id was NOT NULL (20260901000400), the template CHECK never
-- listed 'company_invitation', and the insert result was not checked - so
-- every invitation send went unrecorded, and a bounce on one could never be
-- tied back to a row for handle_bounce_suppression() to act on.
--
-- An invitation is company-scoped, not vendor-scoped, so this makes
-- vendor_id optional rather than inventing a vendor for it:
--   1. vendor_id drops NOT NULL.
--   2. The company/vendor consistency trigger is swapped for a variant that
--      skips a null vendor_id (assert_company_matches_vendor() raises
--      'vendor % does not exist' on one), same shape as
--      assert_task_company_matches_vendor() for tasks.vendor_id.
--   3. 'company_invitation' joins the template allow-list, and is the only
--      template allowed a null vendor_id.
--   4. handle_bounce_suppression() LEFT JOINs vendors, so an invitation
--      bounce still suppresses the address and opens a vendor-less task.
-- ---------------------------------------------------------------------------

-- 1. vendor_id optional -------------------------------------------------------

alter table public.email_outbox
  alter column vendor_id drop not null;

-- 2. Null-skipping company/vendor consistency check ---------------------------

create or replace function public.assert_company_matches_optional_vendor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  if new.vendor_id is null then
    return new;
  end if;

  select company_id into owner_company from public.vendors where id = new.vendor_id;

  if owner_company is null then
    raise exception 'vendor % does not exist', new.vendor_id using errcode = '23503';
  end if;

  if owner_company <> new.company_id then
    raise exception 'company_id % does not match the owning company % of vendor %',
      new.company_id, owner_company, new.vendor_id using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_optional_vendor() from public, anon, authenticated;

drop trigger email_outbox_company_matches_vendor on public.email_outbox;

create trigger email_outbox_company_matches_vendor
  before insert or update on public.email_outbox
  for each row execute function public.assert_company_matches_optional_vendor();

-- 3. Template allow-list ------------------------------------------------------

alter table public.email_outbox
  drop constraint email_outbox_template_check;

alter table public.email_outbox
  add constraint email_outbox_template_check
  check (template in (
    'vendor_onboarding', 'renewal_request', 'document_received', 'admin_review_needed',
    'renewal_reminder', 'compliance_deficiency_escalated', 'compliance_exception_expired',
    'company_invitation'
  ));

-- Only a company-scoped template may omit the vendor. Every other template is
-- about a specific vendor, so a null there is a caller bug and should fail
-- loudly, the way it did before step 1.
alter table public.email_outbox
  add constraint email_outbox_vendor_required_check
  check (vendor_id is not null or template = 'company_invitation');

-- 4. Bounce suppression for vendor-less sends ---------------------------------

-- Identical to 20260916000600_contacts_and_suppression.sql except the vendors
-- join is now a LEFT JOIN and the task title omits the vendor when there is
-- none. The inner join silently dropped every vendor-less outbox row, which
-- then hit the "missing row" fail-open branch and never suppressed anything.
create or replace function public.handle_bounce_suppression()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_company_id uuid;
  v_vendor_id  uuid;
  v_to_email   text;
  v_vendor_name text;
begin
  if new.event_type not in ('bounced', 'complained') then
    return new;
  end if;

  select eo.company_id, eo.vendor_id, eo.to_email, v.name
    into v_company_id, v_vendor_id, v_to_email, v_vendor_name
  from public.email_outbox eo
  left join public.vendors v on v.id = eo.vendor_id
  where eo.id = new.email_outbox_id;

  -- Should not happen - assert_company_matches_email_outbox() already
  -- requires email_outbox_id to resolve - but a missing row here should
  -- fail open (skip suppression/task, still record the delivery event)
  -- rather than blocking the insert this trigger hangs off of.
  if v_to_email is null then
    return new;
  end if;

  insert into public.suppressed_recipients (company_id, email, reason, source_event_id, suppressed_at)
  values (v_company_id, v_to_email, new.event_type, new.id, new.occurred_at)
  on conflict (company_id, email) do update
    set reason          = excluded.reason,
        source_event_id = excluded.source_event_id,
        suppressed_at   = excluded.suppressed_at,
        updated_at      = now();

  insert into public.tasks (company_id, vendor_id, title, priority, status)
  values (
    v_company_id,
    v_vendor_id,
    case
      when v_vendor_id is null then
        format('Email %s for %s - contact suppressed from automated sends',
          new.event_type, v_to_email)
      else
        format('Email %s for %s (%s) - contact suppressed from automated sends',
          new.event_type, coalesce(v_vendor_name, 'a vendor'), v_to_email)
    end,
    'high',
    'open'
  );

  return new;
end;
$fn$;

revoke execute on function public.handle_bounce_suppression() from public, anon, authenticated;
