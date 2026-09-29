-- Self-checkout billing + guided onboarding.
--
-- This migration lays the database foundation for paid self-checkout via Stripe
-- and the post-payment onboarding wizard. It does four things:
--
--   1. Moves the plan vocabulary to the public pricing structure
--      (core / operations / scale / enterprise), replacing the legacy
--      Field / Program / Enterprise codes.
--   2. Adds Stripe billing state to `companies` and a `stripe_events` table so
--      the checkout webhook can be idempotent.
--   3. Adds `service_status` (a second, independent gate: "has VendorClr
--      validated the setup and started service?") and a `company_onboarding`
--      table that stores the wizard's answers and progress.
--   4. Adds `plan_limits` (the vendor / user ceilings per plan) and an
--      active-vendor usage function so the app can show the 90%-utilization
--      notice without blocking anyone.
--
-- Two statuses, deliberately separate:
--   * activation_status (demo / activated / revoked) — is the console open?
--     Self-checkout sets this to 'activated' at payment.
--   * service_status (onboarding / in_review / live) — has VendorClr validated
--     the setup and begun managed service? Self-checkout sets this to
--     'onboarding'; staff move it to 'live' after the Step 6 review.
--
-- Re-runnable: every statement is idempotent or guarded. Applied to staging
-- (ukbgjriqszthtgwxyirr) first; NOT applied to production by this migration.

-- ---------------------------------------------------------------------------
-- 1. Plan vocabulary: core / operations / scale / enterprise
-- ---------------------------------------------------------------------------
--
-- The legacy three (Field / Program / Enterprise) do not map onto the four
-- public plans, so we rename rather than alias. Existing rows are mapped
-- Field -> core, Program -> operations, Enterprise -> enterprise (nothing
-- maps to 'scale' — it is new). Staging has zero companies today, so the
-- UPDATEs are no-ops there, but they keep the migration correct against any
-- populated database.

alter table public.companies drop constraint if exists companies_plan_check;
update public.companies set plan = case plan
  when 'Field' then 'core'
  when 'Program' then 'operations'
  when 'Enterprise' then 'enterprise'
  else plan end
where plan in ('Field', 'Program', 'Enterprise');
alter table public.companies alter column plan set default 'core';
alter table public.companies
  add constraint companies_plan_check
  check (plan in ('core', 'operations', 'scale', 'enterprise'));

alter table public.activation_codes drop constraint if exists activation_codes_plan_check;
update public.activation_codes set plan = case plan
  when 'Field' then 'core'
  when 'Program' then 'operations'
  when 'Enterprise' then 'enterprise'
  else plan end
where plan in ('Field', 'Program', 'Enterprise');
alter table public.activation_codes alter column plan set default 'core';
alter table public.activation_codes
  add constraint activation_codes_plan_check
  check (plan in ('core', 'operations', 'scale', 'enterprise'));

-- ---------------------------------------------------------------------------
-- 2. plan_limits: the vendor / user ceilings behind each plan
-- ---------------------------------------------------------------------------
--
-- NULL means "no ceiling" (Scale users, Scale/Enterprise seats, Enterprise
-- vendors). Read by the app to render limits and to compute the utilization
-- notice; safe for everyone to read, so it carries a public SELECT policy.

create table if not exists public.plan_limits (
  plan                text primary key
                        check (plan in ('core', 'operations', 'scale', 'enterprise')),
  label               text not null,
  max_active_vendors  integer check (max_active_vendors is null or max_active_vendors > 0),
  max_internal_users  integer check (max_internal_users is null or max_internal_users > 0),
  managed_service     text not null,
  self_checkout       boolean not null default false,
  sort_order          integer not null default 0
);

comment on table public.plan_limits is
  'Vendor / internal-user ceilings and managed-service level per plan. NULL ceiling = unlimited. Public reference data (staff-managed); read by the app for limits and the 90%-utilization notice.';

insert into public.plan_limits (plan, label, max_active_vendors, max_internal_users, managed_service, self_checkout, sort_order) values
  ('core',       'Core',       75,   3,    'basic',    true,  1),
  ('operations', 'Operations', 200,  10,   'full',     true,  2),
  ('scale',      'Scale',      300,  null, 'priority', true,  3),
  ('enterprise', 'Enterprise', null, null, 'custom',   false, 4)
on conflict (plan) do update set
  label              = excluded.label,
  max_active_vendors = excluded.max_active_vendors,
  max_internal_users = excluded.max_internal_users,
  managed_service    = excluded.managed_service,
  self_checkout      = excluded.self_checkout,
  sort_order         = excluded.sort_order;

grant select on public.plan_limits to anon, authenticated;
grant all on public.plan_limits to service_role;

alter table public.plan_limits enable row level security;

drop policy if exists plan_limits_select on public.plan_limits;
create policy plan_limits_select on public.plan_limits
  for select to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- 3. companies: Stripe billing state + service_status
-- ---------------------------------------------------------------------------
--
-- Written only by the webhook (service_role) and the definer functions below;
-- there is no member-facing UPDATE policy on these columns. subscription_status
-- mirrors Stripe's own subscription status vocabulary.

alter table public.companies
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status    text
    check (subscription_status is null or subscription_status in (
      'trialing', 'active', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )),
  add column if not exists current_period_end     timestamptz,
  add column if not exists cancel_at_period_end    boolean not null default false,
  add column if not exists billing_email          text,
  add column if not exists service_status         text not null default 'onboarding'
    check (service_status in ('onboarding', 'in_review', 'live'));

comment on column public.companies.service_status is
  'Managed-service readiness, independent of activation_status. onboarding = paid, wizard not finished; in_review = wizard submitted, VendorClr validating; live = service active. Self-checkout starts at onboarding; activation-code redemption starts at live.';
comment on column public.companies.stripe_customer_id is
  'Stripe Customer id (cus_...). Set by the checkout webhook; NULL for activation-code / enterprise companies with no self-checkout subscription.';

-- One Stripe customer / subscription maps to at most one company.
create unique index if not exists companies_stripe_customer_id_key
  on public.companies (stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists companies_stripe_subscription_id_key
  on public.companies (stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists companies_service_status_idx
  on public.companies (service_status) where service_status <> 'live';

-- Companies that already exist are already operating, so they are 'live', not
-- stuck in onboarding. No-op on staging (zero rows); correct on prod.
update public.companies set service_status = 'live'
where service_status = 'onboarding'
  and activation_status = 'activated';

-- ---------------------------------------------------------------------------
-- 4. stripe_events: webhook idempotency + a durable record
-- ---------------------------------------------------------------------------
--
-- The webhook inserts the event id before processing and marks processed_at on
-- success, so a redelivered event is a no-op. Service-role only: no RLS policy
-- is defined, which denies every non-service caller.

create table if not exists public.stripe_events (
  id            text primary key,          -- Stripe event id (evt_...)
  type          text not null,
  payload       jsonb,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

comment on table public.stripe_events is
  'Every Stripe webhook event this app has seen, keyed by Stripe event id for idempotency. Written only by the webhook via service_role; RLS is enabled with no policy, so no other role can read or write it.';

grant all on public.stripe_events to service_role;
alter table public.stripe_events enable row level security;

-- ---------------------------------------------------------------------------
-- 5. company_onboarding: the wizard's answers and progress
-- ---------------------------------------------------------------------------
--
-- One row per company, upserted by members as they move through the wizard.
-- Steps 1-3 and 5 are stored as jsonb (flexible while the wizard settles);
-- Step 4 (vendors) reuses the existing CSV import and Step 6 (review) is staff
-- work. submitted_at is set by submit_company_onboarding(); the company's
-- service_status is the authoritative gate.

create table if not exists public.company_onboarding (
  company_id     uuid primary key references public.companies (id) on delete cascade,
  current_step   integer not null default 1 check (current_step between 1 and 7),
  company_info   jsonb not null default '{}'::jsonb,   -- Step 1
  program        jsonb not null default '{}'::jsonb,   -- Step 2
  projects       jsonb not null default '{}'::jsonb,   -- Step 3
  requirements   jsonb not null default '{}'::jsonb,   -- Step 5
  submitted_at   timestamptz,
  reviewed_at    timestamptz,
  reviewed_by    uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.company_onboarding is
  'Post-checkout onboarding wizard state, one row per company. Members read/write their own company row; staff read all for the Step 6 review. Progress is informational; the gate is companies.service_status.';

drop trigger if exists company_onboarding_touch_updated_at on public.company_onboarding;
create trigger company_onboarding_touch_updated_at
  before update on public.company_onboarding
  for each row execute function public.touch_updated_at();

grant select, insert, update on public.company_onboarding to authenticated;
grant all on public.company_onboarding to service_role;

alter table public.company_onboarding enable row level security;

-- Members of the company (any role) can see their onboarding row; staff see all.
drop policy if exists company_onboarding_select on public.company_onboarding;
create policy company_onboarding_select on public.company_onboarding
  for select to authenticated
  using (
    company_id in (select company_id from public.current_company_ids())
    or public.is_platform_admin()
  );

-- Writers (owner/admin per can_write_company) fill and update the wizard.
drop policy if exists company_onboarding_insert on public.company_onboarding;
create policy company_onboarding_insert on public.company_onboarding
  for insert to authenticated
  with check (public.can_write_company(company_id));

drop policy if exists company_onboarding_update on public.company_onboarding;
create policy company_onboarding_update on public.company_onboarding
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

-- ---------------------------------------------------------------------------
-- 6. audit_log vocabulary
-- ---------------------------------------------------------------------------
--
-- Widen the action CHECK to cover the billing / onboarding lifecycle. The full
-- existing list is preserved verbatim; four actions are appended. target_type
-- is unchanged — all of these are recorded against 'company'.

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log
  add constraint audit_log_action_check
  check (action = any (array[
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
    'requirement_profile_created', 'requirement_profile_updated', 'requirement_profile_archived',
    'requirement_profile_defaulted',
    'contact_created', 'contact_updated', 'vendor_contact_linked',
    'vendor_contact_role_changed', 'vendor_contact_unlinked',
    'recipient_suppressed', 'recipient_unsuppressed',
    -- appended by this migration:
    'checkout_completed', 'subscription_updated', 'onboarding_submitted', 'service_activated'
  ]));

-- ---------------------------------------------------------------------------
-- 7. Active-vendor usage
-- ---------------------------------------------------------------------------
--
-- An active vendor is one that is not archived. A vendor assigned to multiple
-- projects is a single vendors row, so it already counts once. Returns the
-- count, the plan ceiling (NULL = unlimited) and the utilization ratio so the
-- app can raise the ~90% notice. SECURITY DEFINER with an explicit membership /
-- staff check, matching the rest of this schema.

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
    target_company in (select company_id from public.current_company_ids())
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

-- ---------------------------------------------------------------------------
-- 8. Onboarding + service-status transitions
-- ---------------------------------------------------------------------------

-- Customer marks the wizard finished: onboarding -> in_review. Idempotent, and
-- only advances from 'onboarding' so it never pulls a live company backwards.
create or replace function public.submit_company_onboarding(target_company uuid)
returns public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  actor  uuid := (select auth.uid());
  result public.companies;
begin
  if not public.can_write_company(target_company) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.company_onboarding
  set submitted_at = coalesce(submitted_at, now()),
      current_step = greatest(current_step, 6)
  where company_id = target_company;

  update public.companies
  set service_status = 'in_review'
  where id = target_company and service_status = 'onboarding'
  returning * into result;

  -- If service_status was not 'onboarding', nothing changed; return current row.
  if result.id is null then
    select * into result from public.companies where id = target_company;
  else
    insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
    values (target_company, actor, 'onboarding_submitted', 'company', target_company,
            jsonb_build_object('service_status', 'in_review'));
  end if;

  return result;
end;
$fn$;

revoke execute on function public.submit_company_onboarding(uuid) from public, anon;
grant execute on function public.submit_company_onboarding(uuid) to authenticated;

-- Staff move a company's managed-service status (e.g. Step 7 launch -> 'live').
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

  if next_status = 'live' then
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
-- 9. Refresh the two activation-code functions for the new plan vocabulary
-- ---------------------------------------------------------------------------
--
-- create_activation_code(): default plan is now 'core' and the allowed set is
-- the four public plans. Otherwise unchanged from the activation_codes
-- migration.

create or replace function public.create_activation_code(
  target_email   text,
  target_company text,
  target_plan    text default 'core',
  renews_on      date default null,
  note           text default null
)
returns public.activation_codes
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  result   public.activation_codes;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if length(btrim(coalesce(target_email, ''))) = 0 then
    raise exception 'email is required' using errcode = '22023';
  end if;
  if length(btrim(coalesce(target_company, ''))) = 0 then
    raise exception 'company_name is required' using errcode = '22023';
  end if;
  if coalesce(target_plan, 'core') not in ('core', 'operations', 'scale', 'enterprise') then
    raise exception 'plan must be core, operations, scale or enterprise' using errcode = '22023';
  end if;

  insert into public.activation_codes (email, company_name, plan, renews_on, note, created_by)
  values (target_email, target_company, coalesce(target_plan, 'core'), renews_on,
          nullif(btrim(coalesce(note, '')), ''), admin_id)
  returning * into result;

  return result;
end;
$fn$;

revoke execute on function public.create_activation_code(text, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.create_activation_code(text, text, text, date, text)
  to authenticated;

-- redeem_activation_code(): unchanged except the new company is created
-- service_status 'live'. An activation code is the staff / enterprise path —
-- VendorClr has already set the customer up, so they skip the self-serve
-- wizard. (Self-checkout, handled by the webhook, creates companies at
-- service_status 'onboarding' instead.)

create or replace function public.redeem_activation_code(entered_code text)
returns public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller_id    uuid := (select auth.uid());
  caller_email text := lower((select email from auth.users where id = caller_id));
  cleaned      text := upper(btrim(coalesce(entered_code, '')));
  matched      public.activation_codes;
  new_company  uuid;
begin
  if caller_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if exists (select 1 from public.company_members where user_id = caller_id) then
    raise exception 'This account already has a VendorClr workspace.';
  end if;

  if length(cleaned) = 0 then
    raise exception 'That code was not recognised.';
  end if;

  select * into matched
  from public.activation_codes
  where code = cleaned
    and status = 'pending'
    and email = caller_email
  for update;

  if matched.id is null then
    raise exception 'That code was not recognised.';
  end if;

  insert into public.companies (
    name, plan, activation_status, activated_at, activated_by,
    subscription_renews_on, service_status
  )
  values (
    left(btrim(matched.company_name), 200),
    matched.plan,
    'activated',
    now(),
    caller_id,
    matched.renews_on,
    'live'
  )
  returning id into new_company;

  insert into public.company_members (company_id, user_id, role, last_active_at)
  values (new_company, caller_id, 'owner', now())
  on conflict (company_id, user_id) do nothing;

  update public.activation_codes
  set status = 'used', used_at = now(), used_by = caller_id, redeemed_company_id = new_company
  where id = matched.id;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    new_company, caller_id, 'activation_code_redeemed', 'activation_code', matched.id,
    jsonb_build_object('company_name', matched.company_name, 'plan', matched.plan)
  );

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    new_company, caller_id, 'company_activated', 'company', new_company,
    jsonb_build_object('plan', matched.plan, 'source', 'activation_code')
  );

  return (select c from public.companies c where id = new_company);
end;
$fn$;

revoke execute on function public.redeem_activation_code(text)
  from public, anon, authenticated;
grant execute on function public.redeem_activation_code(text) to authenticated;
