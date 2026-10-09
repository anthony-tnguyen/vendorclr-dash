-- Let VendorClr staff (platform_admins) send a COI / document upload request on
-- a customer's behalf.
--
-- The send path (sendRequest server fn -> prepare_contact_request + inserts into
-- vendor_upload_requests and email_outbox) authorizes every write with
-- can_write_company() alone, which a staff account (a member of no company)
-- never satisfies. The contacts side was already widened for staff in
-- 20261009000100; this does the same for the request/outbox side, in the same
-- house style: `can_write_company(...) or is_platform_admin()`. can_write_company
-- itself is left as the members-only primitive.
--
-- Re-runnable. Applied to staging (ukbgjriqszthtgwxyirr), then production
-- (fzrcowwonezflydicpbd).

-- vendor_upload_requests: staff may create and update requests for any company.
drop policy if exists vendor_upload_requests_insert on public.vendor_upload_requests;
create policy vendor_upload_requests_insert on public.vendor_upload_requests
  for insert to authenticated
  with check (public.can_write_company(company_id) or public.is_platform_admin());

drop policy if exists vendor_upload_requests_update on public.vendor_upload_requests;
create policy vendor_upload_requests_update on public.vendor_upload_requests
  for update to authenticated
  using (public.can_write_company(company_id) or public.is_platform_admin())
  with check (public.can_write_company(company_id) or public.is_platform_admin());

-- email_outbox: staff's sends (and the suppressed-recipient rows
-- prepare_contact_request writes) must be insertable for any company.
drop policy if exists email_outbox_insert on public.email_outbox;
create policy email_outbox_insert on public.email_outbox
  for insert to authenticated
  with check (public.can_write_company(company_id) or public.is_platform_admin());

-- prepare_contact_request: the database half of sendRequest(). Identical to
-- 20260922120000 except the authorization check now also admits a platform
-- admin. security invoker, so the inserts above still run under the widened
-- RLS policies as the calling staff member.
create or replace function public.prepare_contact_request(
  p_vendor_id uuid,
  p_contact_ids uuid[],
  p_purpose text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_resend_of_request_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_vendor record;
  v_requested uuid[];
  v_unlinked uuid[];
  v_eligible int;
  v_request_id uuid;
  v_previous record;
  v_recipients jsonb;
begin
  -- RLS hides other companies' vendors, so "not yours" and "does not
  -- exist" are deliberately the same answer.
  select v.id, v.name, v.company_id, coalesce(c.name, 'Your client') as company_name
    into v_vendor
  from public.vendors v
  left join public.companies c on c.id = v.company_id
  where v.id = p_vendor_id;

  if v_vendor.id is null then
    raise exception 'Vendor not found.' using errcode = 'P0002';
  end if;

  if not (public.can_write_company(v_vendor.company_id) or public.is_platform_admin()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_requested
  from unnest(coalesce(p_contact_ids, '{}')) as x
  where x is not null;

  if cardinality(v_requested) = 0 then
    raise exception 'Select at least one recipient.' using errcode = '22023';
  end if;

  -- Every requested id must be a contact of THIS company linked to THIS
  -- vendor. One bad id rejects the whole request rather than being
  -- silently dropped - the sender must see exactly who receives it.
  select coalesce(array_agg(r), '{}') into v_unlinked
  from unnest(v_requested) as r
  where not exists (
    select 1
    from public.vendor_contacts vc
    join public.contacts c on c.id = vc.contact_id
    where vc.vendor_id = v_vendor.id
      and vc.contact_id = r
      and vc.company_id = v_vendor.company_id
      and c.company_id = v_vendor.company_id
  );

  if cardinality(v_unlinked) > 0 then
    raise exception 'Recipient % is not a contact of this vendor.', v_unlinked[1]
      using errcode = '22023';
  end if;

  -- One entry per contact; a contact holding several roles on this vendor
  -- is addressed by its most specific one.
  select coalesce(jsonb_agg(jsonb_build_object(
           'contactId', t.contact_id,
           'vendorContactId', t.vendor_contact_id,
           'name', t.name,
           'email', t.email,
           'organization', t.organization,
           'role', t.role,
           'suppressionReason', t.suppression_reason
         ) order by case t.role when 'operational' then 0 when 'broker' then 1 else 2 end, t.name), '[]'::jsonb)
    into v_recipients
  from (
    select distinct on (c.id)
           c.id as contact_id, vc.id as vendor_contact_id, c.name, c.email, c.organization,
           vc.role, s.reason as suppression_reason
    from public.vendor_contacts vc
    join public.contacts c on c.id = vc.contact_id
    left join public.suppressed_recipients s
      on s.company_id = v_vendor.company_id and s.email = lower(btrim(c.email))
    where vc.vendor_id = v_vendor.id and vc.contact_id = any (v_requested)
    order by c.id, case vc.role when 'operational' then 0 when 'broker' then 1 else 2 end
  ) t;

  select count(*) into v_eligible
  from jsonb_array_elements(v_recipients) e
  where e ->> 'suppressionReason' is null;

  if v_eligible = 0 then
    raise exception 'Every selected recipient is suppressed (bounced, complained or marked do-not-email). Nothing was sent.'
      using errcode = '22023';
  end if;

  -- A resend retires the request it replaces: its magic link stops working
  -- the moment the new one exists, so there is never more than one live
  -- token per resend chain. Only a request the vendor has not acted on can
  -- be cancelled; one already uploaded against stays exactly as it is.
  if p_resend_of_request_id is not null then
    select id, status into v_previous
    from public.vendor_upload_requests
    where id = p_resend_of_request_id and vendor_id = v_vendor.id;

    if v_previous.id is null then
      raise exception 'The request being resent does not belong to this vendor.' using errcode = '22023';
    end if;

    if v_previous.status in ('pending', 'email_sent', 'opened') then
      update public.vendor_upload_requests set status = 'cancelled' where id = v_previous.id;
    end if;
  end if;

  insert into public.vendor_upload_requests
    (company_id, vendor_id, token_hash, purpose, expires_at, created_by, resend_of_request_id)
  values
    (v_vendor.company_id, v_vendor.id, p_token_hash, p_purpose, p_expires_at, public.current_user_id(), p_resend_of_request_id)
  returning id into v_request_id;

  -- Excluded recipients are part of the record: communication history
  -- shows who was deliberately not emailed and why.
  insert into public.email_outbox
    (company_id, vendor_id, upload_request_id, template, to_email, status, error, contact_id, recipient_role)
  select v_vendor.company_id, v_vendor.id, v_request_id, 'renewal_request', e ->> 'email', 'suppressed',
         'Not sent: address is suppressed (' || (e ->> 'suppressionReason') || ').',
         (e ->> 'contactId')::uuid, e ->> 'role'
  from jsonb_array_elements(v_recipients) e
  where e ->> 'suppressionReason' is not null;

  return jsonb_build_object(
    'requestId', v_request_id,
    'companyId', v_vendor.company_id,
    'vendorName', v_vendor.name,
    'companyName', v_vendor.company_name,
    'recipients', v_recipients
  );
end;
$fn$;

revoke execute on function public.prepare_contact_request(uuid, uuid[], text, text, timestamptz, uuid) from public, anon;
grant execute on function public.prepare_contact_request(uuid, uuid[], text, text, timestamptz, uuid) to authenticated;
