-- Phase 3 continued / migration 10 - renewal reminder detection.
--
-- Only the detection side lives here: policy_reminder_log tracks which
-- threshold has already fired for which policy, current_reminder_threshold()
-- picks the single applicable tier for a given day-count, and
-- policies_due_for_reminder surfaces exactly the rows a scheduled job should
-- act on. Actually sending email is not something plain SQL can do - see the
-- Edge Function this view feeds (supabase/functions/send-renewal-reminders),
-- scheduled by pg_cron via pg_net in a later migration once the function is
-- deployed and its URL is known.
--
-- Deliberately keyed off general_liability specifically, same reasoning as
-- everywhere else in this schema: it is the policy that drives the
-- compliance rail (primaryPolicy() in supabaseRepository.ts,
-- computeComplianceItems() in complianceEngine.ts). A renewal naturally
-- resets the reminder cycle for free: apply_policy_renewal() always creates a
-- new vendor_policies row rather than mutating the old one, and
-- policy_reminder_log is keyed by policy_id - a fresh row has no log entries,
-- so the 90-day tier is available again immediately.
--
-- Deliberately does NOT enable pg_cron/pg_net here, unlike every other
-- migration in this project. Both require actual background workers and
-- real networking that PGlite - a single-process WASM build - cannot provide,
-- so a `create extension` for either would break db:verify for the entire
-- schema, not just this table. They're enabled in
-- 20260902000600_schedule_renewal_reminders.sql instead, which the PGlite
-- harness explicitly skips (see the SKIPPED_IN_PGLITE comment in
-- supabase/tests/harness.ts) - everything in *this* file has no such
-- dependency and is fully covered by db:verify like everything else.

-- One more email_outbox template, same widening pattern as migration 9: the
-- Edge Function records its sends here so a reminder shows up in the same
-- outbox a company admin already sees for manually-triggered requests.
alter table public.email_outbox
  drop constraint email_outbox_template_check;

alter table public.email_outbox
  add constraint email_outbox_template_check
  check (template in (
    'vendor_onboarding', 'renewal_request', 'document_received', 'admin_review_needed', 'renewal_reminder'
  ));

create table public.policy_reminder_log (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  policy_id      uuid not null references public.vendor_policies (id) on delete cascade,
  days_threshold smallint not null check (days_threshold in (90, 60, 30, 14, 7)),
  sent_at        timestamptz not null default now(),
  -- The uniqueness that makes this idempotent: a given tier can only ever be
  -- logged once per policy row, so a cron job that runs twice in one day (or
  -- retries after a partial failure) cannot double-send.
  unique (policy_id, days_threshold)
);

create index policy_reminder_log_policy_idx on public.policy_reminder_log (policy_id);
create index policy_reminder_log_company_idx on public.policy_reminder_log (company_id);
create index policy_reminder_log_vendor_idx on public.policy_reminder_log (vendor_id);

create trigger policy_reminder_log_company_matches_vendor
  before insert or update on public.policy_reminder_log
  for each row execute function public.assert_company_matches_vendor();

alter table public.policy_reminder_log enable row level security;

-- Read-only for company members / staff, matching compliance_queue_items'
-- shape - this is an operational log, not something a customer edits. Writes
-- come exclusively from the Edge Function via the service role, which
-- bypasses RLS the same way it already does for vendor_documents.
create policy policy_reminder_log_select on public.policy_reminder_log
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Threshold selection
-- ---------------------------------------------------------------------------

-- The single reminder tier that currently applies to a policy with this many
-- days left, or null if none does (already expired, or still more than 90
-- days out). Picks the *tightest* applicable tier - 45 days left resolves to
-- 60, not 90 - so a job that runs daily sends exactly one reminder per
-- threshold crossed, not a backlog of every tier a policy has passed through.
create or replace function public.current_reminder_threshold(days_until int)
returns smallint
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select case
    when days_until < 0 then null
    else (select min(t) from unnest(array[90, 60, 30, 14, 7]) as t where t >= days_until)
  end;
$fn$;

revoke execute on function public.current_reminder_threshold(int) from public, anon;
grant execute on function public.current_reminder_threshold(int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What a scheduled job should act on right now
-- ---------------------------------------------------------------------------

create view public.policies_due_for_reminder
with (security_invoker = true) as
select
  vp.id as policy_id,
  vp.vendor_id,
  vp.company_id,
  vp.expiration_date,
  public.current_reminder_threshold((vp.expiration_date - current_date)::int) as days_threshold
from public.vendor_policies vp
where vp.policy_type = 'general_liability'
  and vp.status = 'active'
  and vp.expiration_date is not null
  and public.current_reminder_threshold((vp.expiration_date - current_date)::int) is not null
  and not exists (
    select 1 from public.policy_reminder_log prl
    where prl.policy_id = vp.id
      and prl.days_threshold = public.current_reminder_threshold((vp.expiration_date - current_date)::int)
  );
