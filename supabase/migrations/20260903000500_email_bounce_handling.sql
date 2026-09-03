-- Phase 4 / migration 19 - email bounce handling, the last item under
-- "What is still not built."
--
-- email_outbox already answers "did we attempt to send this" - status
-- 'queued'/'sent'/'failed' is set once, at send time, by the app itself.
-- It has never answered "what actually happened to it after Resend
-- accepted it" - did it bounce, did the recipient mark it spam. This
-- migration is the moment the README's own "Known compromises" entry on
-- email_outbox called out: "split it once delivery-webhook data (opened/
-- clicked/bounced) needs its own lifecycle." An email's post-send lifecycle
-- is genuinely multi-event (sent, then later delivered, or sent then
-- bounced, sometimes both a delay and then a bounce) - a single mutable
-- status column cannot represent that history, only its latest value. So:
--
--   email_delivery_events - append-only, one row per webhook event
--   received from Resend (send-side attempt tracking, unchanged, still
--   lives on email_outbox itself).
--
-- email_outbox.status is still updated to the latest "delivery outcome"
-- event (delivered/bounced/complained) for at-a-glance dashboards without a
-- join - but email_delivery_events is the actual record of what happened
-- and when; status is a derived summary, not the source of truth.
--
-- Written exclusively by a new Edge Function (supabase/functions/
-- resend-webhook) on the service role - Resend calls it directly over
-- HTTP, so there is no signed-in company member to run this as, the same
-- reasoning the anonymous vendor-portal endpoints already follow.

alter table public.email_outbox
  drop constraint email_outbox_status_check;

alter table public.email_outbox
  add constraint email_outbox_status_check
  check (status in ('queued', 'sent', 'failed', 'delivered', 'bounced', 'complained'));

create table public.email_delivery_events (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  email_outbox_id uuid not null references public.email_outbox (id) on delete cascade,
  event_type      text not null check (event_type in (
                     'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained'
                   )),
  -- Resend's own event payload (data field), kept verbatim rather than
  -- picking fields out ahead of time - a bounce reason or complaint detail
  -- worth showing a human later is exactly the kind of thing not to have
  -- discarded on the way in.
  detail          jsonb not null default '{}'::jsonb,
  -- From the webhook payload's own created_at, not when this row was
  -- inserted - a delayed webhook delivery should not misreport when the
  -- event actually happened.
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now()
);

create index email_delivery_events_outbox_idx on public.email_delivery_events (email_outbox_id);
create index email_delivery_events_company_idx on public.email_delivery_events (company_id);

-- Same integrity check every other child table in this schema has against
-- its own parent (assert_company_matches_vendor(), for vendor-scoped
-- tables) - here against email_outbox instead, since this table has no
-- vendor_id of its own. Fires on every insert regardless of role,
-- including the service role the Edge Function writes as: a bug in that
-- function passing a mismatched company_id is exactly the kind of mistake
-- this exists to catch, not just a cross-tenant RLS bypass to guard
-- against.
create or replace function public.assert_company_matches_email_outbox()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  owner_company uuid;
begin
  select company_id into owner_company from public.email_outbox where id = new.email_outbox_id;
  if owner_company is null or owner_company != new.company_id then
    raise exception 'company_id % does not match the owning email_outbox row''s company %',
      new.company_id, owner_company;
  end if;
  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_email_outbox() from public, anon, authenticated;

create trigger email_delivery_events_company_matches_outbox
  before insert or update on public.email_delivery_events
  for each row execute function public.assert_company_matches_email_outbox();

alter table public.email_delivery_events enable row level security;

-- Read-only for company members/staff, matching policy_reminder_log's
-- shape - this is an operational log, not something a customer edits.
-- Writes come exclusively from the resend-webhook Edge Function via the
-- service role, which bypasses RLS the same way it already does for
-- vendor_documents.
create policy email_delivery_events_select on public.email_delivery_events
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());
