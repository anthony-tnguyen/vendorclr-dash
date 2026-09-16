-- Task 7 - contacts, deliverability and communication recovery.
--
-- Three additive pieces:
--
--   contacts / vendor_contacts - a company-scoped address book, separate
--   from vendors.contact_name/contact_email (which stay exactly as they
--   are - a Phase 0-era single free-text pair, never migrated by this
--   migration). One contact can link to several vendors, and one vendor can
--   have several contacts, each tagged with the role sendRequest()/a future
--   UI sends to them as: 'operational' (day-to-day COI contact),
--   'broker' (the vendor's insurance broker - who often actually needs to
--   receive the request), 'secondary' (anyone else worth cc'ing).
--
--   suppressed_recipients - an active "do not auto-email this address"
--   list, company-scoped. Upserted (one row per company+email, latest
--   reason wins) by the trigger below whenever a bounce or spam complaint
--   comes in - closing the exact gap supabase/README.md's Known
--   compromises called out by name: "A bounce/complaint does not trigger
--   any follow-up action."
--
--   handle_bounce_suppression() - an AFTER INSERT trigger on
--   email_delivery_events (migration 19), not new code in the
--   resend-webhook Edge Function. That function already inserts one
--   email_delivery_events row per bounce/complaint it receives - a
--   trigger on that insert gets the suppression logic for free, without
--   resend-webhook needing to know suppressed_recipients or tasks exist at
--   all. This also means the behaviour is exercised by the same PGlite
--   harness every other schema invariant in this project is (insert a
--   bounced event, assert a suppression row and a task appear) rather than
--   only being checkable against the live Edge Function - the same
--   database-layer-over-application-code preference this schema already
--   follows for assert_company_matches_vendor() and friends.

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------

create table public.contacts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 200),
  email      text not null check (position('@' in email) > 1),
  phone      text not null default '',
  notes      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_company_idx on public.contacts (company_id);

create trigger contacts_touch_updated_at
  before update on public.contacts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- vendor_contacts - the link table
-- ---------------------------------------------------------------------------

create table public.vendor_contacts (
  id         uuid primary key default gen_random_uuid(),
  -- Denormalised from vendors, same reasoning as every other vendor-scoped
  -- child table in this schema (vendor_policies, email_outbox, ...): RLS
  -- stays one indexed predicate, kept honest by the trigger below.
  company_id uuid not null references public.companies (id) on delete cascade,
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  role       text not null check (role in ('operational', 'broker', 'secondary')),
  created_at timestamptz not null default now(),
  -- Not unique on (vendor_id, contact_id) alone: the same person can
  -- legitimately be tagged both 'broker' and 'secondary' on one vendor.
  -- This only blocks the exact-duplicate row.
  unique (vendor_id, contact_id, role)
);

create index vendor_contacts_vendor_idx on public.vendor_contacts (vendor_id);
create index vendor_contacts_contact_idx on public.vendor_contacts (contact_id);
create index vendor_contacts_company_idx on public.vendor_contacts (company_id);

-- Same integrity shape as assert_company_matches_vendor() (migration 2):
-- without this, a caller who can write to company A could link a contact
-- row they own to a vendor owned by company B, or vice versa. Both the
-- INSERT policy and the two FKs would individually pass; only this catches
-- the cross-tenant mismatch between them.
create or replace function public.assert_company_matches_contact()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  select company_id into owner_company from public.contacts where id = new.contact_id;

  if owner_company is null then
    raise exception 'contact % does not exist', new.contact_id using errcode = '23503';
  end if;

  if owner_company <> new.company_id then
    raise exception 'company_id % does not match the owning company % of contact %',
      new.company_id, owner_company, new.contact_id using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_contact() from public, anon, authenticated;

create trigger vendor_contacts_company_matches_vendor
  before insert or update on public.vendor_contacts
  for each row execute function public.assert_company_matches_vendor();

create trigger vendor_contacts_company_matches_contact
  before insert or update on public.vendor_contacts
  for each row execute function public.assert_company_matches_contact();

-- ---------------------------------------------------------------------------
-- suppressed_recipients - active "do not auto-email" list
-- ---------------------------------------------------------------------------

create table public.suppressed_recipients (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  -- Always lower(btrim(...)) - see normalize_suppressed_recipient_email()
  -- below - so "Dana@Corbett.example" and "dana@corbett.example" collapse
  -- to one active suppression rather than two.
  email           text not null check (position('@' in email) > 1),
  reason          text not null check (reason in ('bounced', 'complained', 'manual')),
  -- The specific delivery event that caused this, when there is one -
  -- null for a manually-entered suppression. on delete set null rather
  -- than cascade: the suppression itself should outlive the event row
  -- being pruned, if this project ever adds retention cleanup for
  -- email_delivery_events.
  source_event_id uuid references public.email_delivery_events (id) on delete set null,
  suppressed_at   timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One active suppression per company+email - a second bounce just
  -- refreshes the existing row (see the trigger's ON CONFLICT below)
  -- rather than accumulating duplicates.
  unique (company_id, email)
);

create index suppressed_recipients_company_idx on public.suppressed_recipients (company_id);

create trigger suppressed_recipients_touch_updated_at
  before update on public.suppressed_recipients
  for each row execute function public.touch_updated_at();

create or replace function public.normalize_suppressed_recipient_email()
returns trigger
language plpgsql
as $fn$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$fn$;

create trigger suppressed_recipients_normalize_email
  before insert or update on public.suppressed_recipients
  for each row execute function public.normalize_suppressed_recipient_email();

-- ---------------------------------------------------------------------------
-- Bounce/complaint -> suppression + task
-- ---------------------------------------------------------------------------

-- Fires on every email_delivery_events insert (migration 19), the same
-- table resend-webhook already writes to for every event it receives - see
-- this migration's own docblock for why the trigger lives here rather than
-- in that function's TypeScript. Only 'bounced'/'complained' events do
-- anything; every other event_type (sent/delivered/delivery_delayed) is a
-- no-op return.
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
  join public.vendors v on v.id = eo.vendor_id
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
    format('Email %s for %s (%s) - contact suppressed from automated sends',
      new.event_type, coalesce(v_vendor_name, 'a vendor'), v_to_email),
    'high',
    'open'
  );

  return new;
end;
$fn$;

revoke execute on function public.handle_bounce_suppression() from public, anon, authenticated;

create trigger email_delivery_events_handle_bounce_suppression
  after insert on public.email_delivery_events
  for each row execute function public.handle_bounce_suppression();

-- ---------------------------------------------------------------------------
-- audit_log - widen action to cover sendRequest()
-- ---------------------------------------------------------------------------

alter table public.audit_log
  drop constraint audit_log_action_check;

alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
    'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
    'member_role_changed', 'member_removed', 'contact_request_sent'
  ));

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.contacts             enable row level security;
alter table public.vendor_contacts      enable row level security;
alter table public.suppressed_recipients enable row level security;

-- contacts --------------------------------------------------------------
-- Same uniform can_write_company() shape as compliance_requirements
-- (migration 13): a contact is operational data any company writer should
-- be able to manage, not something that needs an owner/risk_manager-only
-- delete the way vendors/vendor_policies do (those gate delete more
-- tightly because deleting them destroys compliance history; deleting an
-- address-book entry does not).
create policy contacts_select on public.contacts
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy contacts_insert on public.contacts
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy contacts_update on public.contacts
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy contacts_delete on public.contacts
  for delete to authenticated
  using (public.can_write_company(company_id));

-- vendor_contacts ---------------------------------------------------------
create policy vendor_contacts_select on public.vendor_contacts
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy vendor_contacts_insert on public.vendor_contacts
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy vendor_contacts_update on public.vendor_contacts
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy vendor_contacts_delete on public.vendor_contacts
  for delete to authenticated
  using (public.can_write_company(company_id));

-- suppressed_recipients -----------------------------------------------------
-- Written automatically by handle_bounce_suppression() (a security definer
-- trigger, so it bypasses these policies regardless), but also writable
-- directly by any company writer - an operator confirming a bad address is
-- now fixed should be able to remove a suppression without staff
-- intervention, and someone should be able to hand-suppress an address the
-- webhook never told this schema about.
create policy suppressed_recipients_select on public.suppressed_recipients
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy suppressed_recipients_insert on public.suppressed_recipients
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy suppressed_recipients_update on public.suppressed_recipients
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy suppressed_recipients_delete on public.suppressed_recipients
  for delete to authenticated
  using (public.can_write_company(company_id));
