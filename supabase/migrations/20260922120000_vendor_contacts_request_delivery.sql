-- Vendor contacts, broker management and multi-recipient request delivery.
--
-- Builds on 20260916000600_contacts_and_suppression.sql (contacts,
-- vendor_contacts, suppressed_recipients, handle_bounce_suppression()) and
-- replaces nothing in it. What this adds:
--
--   1. contacts.organization - the broker's agency / the vendor's company
--      name, shown next to each contact on vendor detail.
--
--   2. One contact row per (company, email). A broker who covers ten
--      vendors is one contacts row linked ten times, not ten rows. Existing
--      duplicates are merged into the oldest row first, then a unique index
--      on (company_id, lower(btrim(email))) makes it structural.
--
--   3. Every vendor with a Phase 0-era vendors.contact_email gets that
--      address as an 'operational' contact (backfill now, and on every new
--      vendor via a trigger), so the multi-recipient request flow has a
--      recipient to offer for every vendor without anyone re-typing it.
--
--   4. email_outbox learns who a message went to in contact terms
--      (contact_id, recipient_role) and gains a 'suppressed' status: a
--      recipient deliberately excluded because their address is suppressed
--      is recorded in communication history instead of silently vanishing.
--
--   5. vendor_upload_requests.resend_of_request_id - a resend is a brand new
--      request with a brand new token; this links it to the one it replaced
--      (whose token is cancelled by prepare_contact_request()).
--
--   6. is_email_suppressed() - the single suppression predicate every send
--      path (Node server functions and all three mail-sending Edge
--      Functions) asks before sending.
--
--   7. prepare_contact_request() - the database half of sendRequest()
--      (src/workflows/communications.ts). SECURITY INVOKER, so every read
--      and write in it is decided by the caller's own RLS. It re-derives
--      the recipient list from vendor_contacts rather than trusting the
--      caller: any id not linked to this vendor (another vendor's contact,
--      another company's contact, a made-up uuid) rejects the whole call,
--      suppressed recipients are excluded and recorded, and a call whose
--      every recipient is suppressed creates nothing at all.
--
--   8. Audit rows for contact-management changes.

-- ---------------------------------------------------------------------------
-- 1. contacts.organization
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column organization text not null default ''
    check (length(organization) <= 200);

comment on column public.contacts.organization is
  'Agency or company the contact works for - e.g. the broker''s agency. Free text, display only.';

-- ---------------------------------------------------------------------------
-- 2. One contact per (company, email)
-- ---------------------------------------------------------------------------

-- Merge existing duplicates into the oldest row. After repointing, several
-- links could land on the same (vendor, keeper, role) - the keeper's own
-- link or two duplicates' links - so all but one of each such group are
-- dropped first (preferring the keeper's own link), then the rest are
-- repointed. Nothing references contacts yet except vendor_contacts
-- (email_outbox.contact_id is added below).
with ranked as (
  select id,
         first_value(id) over (
           partition by company_id, lower(btrim(email))
           order by created_at, id
         ) as keeper_id
  from public.contacts
),
links as (
  select vc.id,
         row_number() over (
           partition by vc.vendor_id, vc.role, r.keeper_id
           order by (vc.contact_id = r.keeper_id) desc, vc.created_at, vc.id
         ) as rn
  from public.vendor_contacts vc
  join ranked r on r.id = vc.contact_id
)
delete from public.vendor_contacts vc
using links l
where vc.id = l.id and l.rn > 1;

with ranked as (
  select id,
         first_value(id) over (
           partition by company_id, lower(btrim(email))
           order by created_at, id
         ) as keeper_id
  from public.contacts
)
update public.vendor_contacts vc
set contact_id = r.keeper_id
from ranked r
where vc.contact_id = r.id and r.id <> r.keeper_id;

with ranked as (
  select id,
         first_value(id) over (
           partition by company_id, lower(btrim(email))
           order by created_at, id
         ) as keeper_id
  from public.contacts
)
delete from public.contacts c
using ranked r
where c.id = r.id and r.id <> r.keeper_id;

create unique index contacts_company_email_unique
  on public.contacts (company_id, lower(btrim(email)));

-- ---------------------------------------------------------------------------
-- 3. vendors.contact_email -> operational contact
-- ---------------------------------------------------------------------------

-- Reuses an existing contact with the same address (a broker already in the
-- address book stays one row) and links it as 'operational'. SECURITY
-- DEFINER because it runs inside whatever inserted the vendor - a company
-- member via RLS, or import_vendor_row() - and must not depend on which.
create or replace function public.ensure_vendor_operational_contact()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_contact_id uuid;
begin
  if coalesce(btrim(new.contact_email), '') = '' then
    return null;
  end if;

  insert into public.contacts (company_id, name, email)
  values (
    new.company_id,
    left(coalesce(nullif(btrim(new.contact_name), ''), btrim(new.contact_email)), 200),
    btrim(new.contact_email)
  )
  on conflict (company_id, lower(btrim(email))) do nothing;

  select id into v_contact_id
  from public.contacts
  where company_id = new.company_id and lower(btrim(email)) = lower(btrim(new.contact_email));

  insert into public.vendor_contacts (company_id, vendor_id, contact_id, role)
  values (new.company_id, new.id, v_contact_id, 'operational')
  on conflict (vendor_id, contact_id, role) do nothing;

  return null;
end;
$fn$;

revoke execute on function public.ensure_vendor_operational_contact() from public, anon, authenticated;

create trigger vendors_ensure_operational_contact
  after insert on public.vendors
  for each row execute function public.ensure_vendor_operational_contact();

-- Backfill every existing vendor that has an address but no operational
-- contact yet.
insert into public.contacts (company_id, name, email)
select distinct on (v.company_id, lower(btrim(v.contact_email)))
       v.company_id,
       left(coalesce(nullif(btrim(v.contact_name), ''), btrim(v.contact_email)), 200),
       btrim(v.contact_email)
from public.vendors v
where coalesce(btrim(v.contact_email), '') <> ''
order by v.company_id, lower(btrim(v.contact_email)), v.created_at
on conflict (company_id, lower(btrim(email))) do nothing;

insert into public.vendor_contacts (company_id, vendor_id, contact_id, role)
select v.company_id, v.id, c.id, 'operational'
from public.vendors v
join public.contacts c
  on c.company_id = v.company_id and lower(btrim(c.email)) = lower(btrim(v.contact_email))
where coalesce(btrim(v.contact_email), '') <> ''
  and not exists (
    select 1 from public.vendor_contacts vc
    where vc.vendor_id = v.id and vc.role = 'operational'
  )
on conflict (vendor_id, contact_id, role) do nothing;

-- ---------------------------------------------------------------------------
-- 4. email_outbox: recipient identity + 'suppressed'
-- ---------------------------------------------------------------------------

alter table public.email_outbox
  add column contact_id uuid references public.contacts (id) on delete set null,
  add column recipient_role text check (recipient_role in ('operational', 'broker', 'secondary'));

create index email_outbox_contact_idx on public.email_outbox (contact_id);

alter table public.email_outbox
  drop constraint email_outbox_status_check;

alter table public.email_outbox
  add constraint email_outbox_status_check
  check (status in ('queued', 'sent', 'failed', 'delivered', 'bounced', 'complained', 'suppressed'));

-- assert_company_matches_contact() assumes contact_id is always set; on
-- email_outbox it is optional (every pre-existing row, and every
-- non-contact template, has none).
create or replace function public.assert_company_matches_optional_contact()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  if new.contact_id is null then
    return new;
  end if;

  select company_id into owner_company from public.contacts where id = new.contact_id;

  if owner_company is null or owner_company <> new.company_id then
    raise exception 'contact % does not belong to company %', new.contact_id, new.company_id
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_optional_contact() from public, anon, authenticated;

create trigger email_outbox_company_matches_contact
  before insert or update on public.email_outbox
  for each row execute function public.assert_company_matches_optional_contact();

-- ---------------------------------------------------------------------------
-- 5. vendor_upload_requests.resend_of_request_id
-- ---------------------------------------------------------------------------

alter table public.vendor_upload_requests
  add column resend_of_request_id uuid references public.vendor_upload_requests (id) on delete set null;

create index vendor_upload_requests_resend_of_idx
  on public.vendor_upload_requests (resend_of_request_id);

-- ---------------------------------------------------------------------------
-- 6. is_email_suppressed()
-- ---------------------------------------------------------------------------

-- SECURITY INVOKER: a signed-in member only ever sees their own company's
-- suppressions through RLS, and the service role (Edge Functions) sees all.
-- Normalises exactly as normalize_suppressed_recipient_email() stores.
create or replace function public.is_email_suppressed(p_company_id uuid, p_email text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from public.suppressed_recipients
    where company_id = p_company_id and email = lower(btrim(p_email))
  );
$fn$;

revoke execute on function public.is_email_suppressed(uuid, text) from public, anon;
grant execute on function public.is_email_suppressed(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. prepare_contact_request()
-- ---------------------------------------------------------------------------

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

  if not public.can_write_company(v_vendor.company_id) then
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

-- ---------------------------------------------------------------------------
-- 8. Audit rows for contact management
-- ---------------------------------------------------------------------------

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check check (action in (
  'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
  'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
  'member_role_changed', 'member_removed', 'contact_request_sent',
  'submission_package_finalized', 'submission_document_replaced',
  'extraction_reviewer_edit', 'compliance_exception_approved', 'compliance_exception_expired',
  'vendor_import_executed', 'report_exported',
  'requirement_rule_added', 'requirement_rule_changed', 'requirement_rule_removed',
  'activation_code_redeemed', 'company_activated', 'company_access_revoked',
  'project_created', 'project_updated', 'project_closed',
  'assignment_created', 'assignment_updated', 'assignment_terminated',
  'requirement_profile_created', 'requirement_profile_updated',
  'requirement_profile_archived', 'requirement_profile_defaulted',
  'contact_created', 'contact_updated',
  'vendor_contact_linked', 'vendor_contact_role_changed', 'vendor_contact_unlinked',
  'recipient_suppressed', 'recipient_unsuppressed'
));

alter table public.audit_log drop constraint if exists audit_log_target_type_check;
alter table public.audit_log add constraint audit_log_target_type_check check (target_type in (
  'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
  'company_member', 'company_invitation', 'compliance_deficiency', 'vendor_import_batch',
  'company', 'audit_snapshot', 'requirement_profile', 'activation_code',
  'project', 'project_vendor_assignment',
  'contact', 'vendor_contact', 'suppressed_recipient'
));

create or replace function public.record_contact_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row record;
  v_action text;
  v_target_type text;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;

  -- A company being deleted cascades through these tables; there is no
  -- company left to attribute the row to (and audit_log goes with it).
  if not exists (select 1 from public.companies where id = v_row.company_id) then
    return null;
  end if;

  if tg_table_name = 'contacts' then
    v_target_type := 'contact';
    v_action := case tg_op when 'INSERT' then 'contact_created' else 'contact_updated' end;
  elsif tg_table_name = 'vendor_contacts' then
    v_target_type := 'vendor_contact';
    if tg_op = 'INSERT' then v_action := 'vendor_contact_linked';
    elsif tg_op = 'DELETE' then v_action := 'vendor_contact_unlinked';
    elsif old.role is distinct from new.role then v_action := 'vendor_contact_role_changed';
    else return null; end if;
  else
    v_target_type := 'suppressed_recipient';
    v_action := case tg_op when 'INSERT' then 'recipient_suppressed' else 'recipient_unsuppressed' end;
  end if;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (v_row.company_id, auth.uid(), v_action, v_target_type, v_row.id,
    jsonb_build_object(
      'before', case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      'after', case when tg_op = 'DELETE' then null else to_jsonb(new) end));
  return null;
end;
$fn$;

revoke execute on function public.record_contact_audit() from public, anon, authenticated;

create trigger contacts_audit after insert or update on public.contacts
  for each row execute function public.record_contact_audit();
create trigger vendor_contacts_audit after insert or update or delete on public.vendor_contacts
  for each row execute function public.record_contact_audit();
create trigger suppressed_recipients_audit after insert or delete on public.suppressed_recipients
  for each row execute function public.record_contact_audit();
