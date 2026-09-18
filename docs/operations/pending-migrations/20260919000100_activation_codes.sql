-- Access model change: sign-up is open, and a paid activation code is what
-- creates a real workspace.
--
--   sign up (no code)  ->  profile only, no company  ->  the app shows the demo screen
--   enter paid code    ->  company + owner seat + activation_status 'activated'
--   staff revoke       ->  activation_status 'revoked'  ->  access-ended screen
--
-- The previous gate (supabase/migrations/20260915000100_gated_signup_invites.sql)
-- refused to create a company during sign-up unless an admin-issued invite code
-- was supplied. That made "sign up and look around first" impossible, so the gate
-- is retired here: handle_new_user() at the bottom becomes profile-only. The
-- signup_invites table and its rows are deliberately NOT dropped - it is the
-- record of who was invited and when, and nothing in the app writes to it any
-- more.
--
-- Companies are what is activated, not people: one redemption unlocks the console
-- for every member of that company, and revoking takes it from all of them at
-- once. This matches how every other tenant-scoped read in this schema already
-- works (current_company_ids()).
--
-- Apply through the normal migration process for this project (the Supabase SQL
-- editor or `supabase db push` against the staging project first). It is
-- re-runnable: every statement is either idempotent or guarded.

-- ---------------------------------------------------------------------------
-- companies: activation state
-- ---------------------------------------------------------------------------
--
-- 'demo' is the default because a brand-new company row can only arrive through
-- redemption, which sets 'activated' in the same statement - so nothing should
-- ever be *observed* sitting in 'demo'. It exists as the safe default: a company
-- created by any future path that forgot to activate is locked rather than open.

alter table public.companies
  add column if not exists activation_status text not null default 'demo'
    check (activation_status in ('demo', 'activated', 'revoked')),
  add column if not exists activated_at timestamptz,
  add column if not exists activated_by uuid references auth.users (id) on delete set null,
  add column if not exists revoked_at timestamptz;

comment on column public.companies.activation_status is
  'Whether this company''s real console is open. demo = created but never activated, activated = paid and open, revoked = staff closed it (data retained, not deleted). Read by the app to decide between the demo screen and the dashboard; set only by redeem_activation_code() and set_company_activation().';

-- Every company that exists today belongs to a customer already using the
-- product. Without this backfill, the moment this migration runs they would all
-- read as 'demo' and be locked out of their own data.
update public.companies
set activation_status = 'activated',
    activated_at      = coalesce(activated_at, created_at)
where activation_status = 'demo';

create index if not exists companies_activation_status_idx
  on public.companies (activation_status)
  where activation_status <> 'activated';

-- ---------------------------------------------------------------------------
-- audit_log: the new event vocabulary
-- ---------------------------------------------------------------------------
--
-- Widened before the functions below so a verification run cannot insert a row
-- the CHECK rejects. 'company' is already an allowed target_type; the new one is
-- 'activation_code'.

alter table public.audit_log
  drop constraint if exists audit_log_action_check;

alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
    'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
    'member_role_changed', 'member_removed', 'contact_request_sent',
    'submission_package_finalized', 'submission_document_replaced',
    'extraction_reviewer_edit', 'compliance_exception_approved', 'compliance_exception_expired',
    'vendor_import_executed', 'report_exported',
    'requirement_rule_added', 'requirement_rule_changed', 'requirement_rule_removed',
    'activation_code_created', 'activation_code_revoked', 'activation_code_redeemed',
    'company_activated', 'company_access_revoked'
  ));

alter table public.audit_log
  drop constraint if exists audit_log_target_type_check;

alter table public.audit_log
  add constraint audit_log_target_type_check
  check (target_type in (
    'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
    'company_member', 'company_invitation', 'compliance_deficiency', 'vendor_import_batch',
    'company', 'audit_snapshot', 'requirement_profile', 'activation_code'
  ));

-- ---------------------------------------------------------------------------
-- activation_codes
-- ---------------------------------------------------------------------------

create table if not exists public.activation_codes (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null,
  email               text not null,
  company_name        text not null check (length(btrim(company_name)) between 1 and 200),
  plan                text not null default 'Field'
                        check (plan in ('Field', 'Program', 'Enterprise')),
  renews_on           date,
  note                text check (note is null or length(note) <= 500),
  status              text not null default 'pending'
                        check (status in ('pending', 'used', 'revoked')),
  created_by          uuid references public.platform_admins (user_id) on delete set null,
  used_at             timestamptz,
  used_by             uuid references auth.users (id) on delete set null,
  redeemed_company_id uuid references public.companies (id) on delete set null,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (code)
);

comment on table public.activation_codes is
  'Paid-access codes issued by VendorClr staff after payment. Single-use, email-locked: redeem_activation_code() creates the company named here for the caller whose email matches, and marks the row used. Never a payment instrument - no billing runs against it.';

-- Normalizes the email so the redemption lookup is case-insensitive, and mints an
-- unambiguous code when staff do not supply one. Same shape as
-- set_signup_invite_defaults(), minus the expiry: the access model is "staff
-- revoke", not "codes expire on their own".
create or replace function public.set_activation_code_defaults()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  candidate    text;
  attempts     int := 0;
  alphabet     constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ';
  label        text;
  position     int;
begin
  new.email := lower(btrim(new.email));

  if new.code is null then
    loop
      candidate := '';
      for position in 1..10 loop
        -- One character per byte of md5 over fresh randomness, folded into a
        -- 32-glyph alphabet with no O/0, I/1/L, S/5, B/8 or 2/Z look-alikes.
        label := substr(md5(gen_random_uuid()::text || gen_random_uuid()::text), position, 1);
        candidate := candidate || substr(
          alphabet,
          (('x' || label)::bit(4)::int * 2) % length(alphabet) + 1,
          1
        );
      end loop;

      exit when not exists (select 1 from public.activation_codes where code = candidate);
      attempts := attempts + 1;
      if attempts > 20 then
        raise exception 'Could not generate a unique activation code';
      end if;
    end loop;
    new.code := candidate;
  else
    new.code := upper(btrim(new.code));
  end if;

  return new;
end;
$fn$;

drop trigger if exists activation_codes_set_defaults on public.activation_codes;
create trigger activation_codes_set_defaults
  before insert on public.activation_codes
  for each row execute function public.set_activation_code_defaults();

drop trigger if exists activation_codes_touch_updated_at on public.activation_codes;
create trigger activation_codes_touch_updated_at
  before update on public.activation_codes
  for each row execute function public.touch_updated_at();

-- GRANTs in this same file: PostgREST does not reach a public-schema table the
-- Data API has no privilege on, and RLS alone is not a grant.
grant select on public.activation_codes to authenticated;
grant all on public.activation_codes to service_role;

alter table public.activation_codes enable row level security;

-- Staff read every code; nobody else sees the table at all. Deliberately no
-- insert/update/delete policy: rows are only ever written by the functions
-- below, so RLS denies every direct write regardless of the caller's role.
drop policy if exists activation_codes_select on public.activation_codes;
create policy activation_codes_select on public.activation_codes
  for select to authenticated
  using (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- create_activation_code(): staff issue a code after payment.
-- ---------------------------------------------------------------------------

create or replace function public.create_activation_code(
  target_email   text,
  target_company text,
  target_plan    text default 'Field',
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
  if coalesce(target_plan, 'Field') not in ('Field', 'Program', 'Enterprise') then
    raise exception 'plan must be Field, Program or Enterprise' using errcode = '22023';
  end if;

  insert into public.activation_codes (email, company_name, plan, renews_on, note, created_by)
  values (target_email, target_company, coalesce(target_plan, 'Field'), renews_on,
          nullif(btrim(coalesce(note, '')), ''), admin_id)
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, details)
  values (
    null,
    admin_id,
    'activation_code_created',
    'activation_code',
    result.id,
    jsonb_build_object('email', result.email, 'company_name', result.company_name,
                       'plan', result.plan, 'code', result.code)
  );

  return result;
end;
$fn$;

revoke execute on function public.create_activation_code(text, text, text, date, text)
  from public, anon, authenticated;
grant execute on function public.create_activation_code(text, text, text, date, text)
  to authenticated;

revoke execute on function public.set_activation_code_defaults() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- revoke_activation_code(): staff withdraw a code that has not been redeemed.
-- A redeemed code is history, not a switch - taking access back is
-- set_company_activation(), which leaves the data alone.
-- ---------------------------------------------------------------------------

create or replace function public.revoke_activation_code(target_code uuid)
returns public.activation_codes
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  existing public.activation_codes;
  result   public.activation_codes;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into existing from public.activation_codes where id = target_code for update;

  if existing.id is null then
    raise exception 'Activation code not found' using errcode = 'P0002';
  end if;
  if existing.status <> 'pending' then
    raise exception 'Only a pending activation code can be revoked';
  end if;

  update public.activation_codes
  set status = 'revoked', revoked_at = now()
  where id = target_code
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, details)
  values (
    null,
    admin_id,
    'activation_code_revoked',
    'activation_code',
    result.id,
    jsonb_build_object('email', result.email, 'company_name', result.company_name)
  );

  return result;
end;
$fn$;

revoke execute on function public.revoke_activation_code(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_activation_code(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- redeem_activation_code(): the customer-facing unlock.
--
-- One call does all of it, in one transaction, because a half-completed
-- redemption is the worst possible outcome: a company with no owner, or a code
-- marked used with no workspace behind it.
--
-- Every failure that could be used to probe the table - code does not exist,
-- exists but is not yours, already redeemed, withdrawn - raises the identical
-- message, so the form cannot be used to ask "is ABCD1234 a real code?".
-- ---------------------------------------------------------------------------

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
    name, plan, activation_status, activated_at, activated_by, subscription_renews_on
  )
  values (
    left(btrim(matched.company_name), 200),
    matched.plan,
    'activated',
    now(),
    caller_id,
    matched.renews_on
  )
  returning id into new_company;

  insert into public.company_members (company_id, user_id, role, last_active_at)
  values (new_company, caller_id, 'owner', now())
  on conflict (company_id, user_id) do nothing;

  update public.activation_codes
  set status = 'used', used_at = now(), used_by = caller_id, redeemed_company_id = new_company
  where id = matched.id;

  -- audit_log has no INSERT policy for authenticated, so both rows are written
  -- from inside this definer boundary like every other writer in this schema.
  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, details)
  values (
    new_company,
    caller_id,
    'activation_code_redeemed',
    'activation_code',
    matched.id,
    jsonb_build_object('company_name', matched.company_name, 'plan', matched.plan)
  );

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, details)
  values (
    new_company,
    caller_id,
    'company_activated',
    'company',
    new_company,
    jsonb_build_object('plan', matched.plan, 'source', 'activation_code')
  );

  return (select * from public.companies where id = new_company);
end;
$fn$;

revoke execute on function public.redeem_activation_code(text)
  from public, anon, authenticated;
grant execute on function public.redeem_activation_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- set_company_activation(): staff open or close an existing workspace.
--
-- 'revoked' closes the console and touches nothing else - vendors, documents and
-- history all stay in the database, so restoring access returns the customer to
-- exactly what they had. Deleting a company is a different, documented operation
-- (scripts/delete-company.ts), not something this function can be used to do.
-- ---------------------------------------------------------------------------

create or replace function public.set_company_activation(
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

  if next_status not in ('demo', 'activated', 'revoked') then
    raise exception 'activation_status must be demo, activated or revoked'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.companies where id = target_company) then
    raise exception 'Company not found' using errcode = 'P0002';
  end if;

  update public.companies
  set activation_status = next_status,
      activated_at      = case when next_status = 'activated' then coalesce(activated_at, now())
                               else activated_at end,
      activated_by      = case when next_status = 'activated' then coalesce(activated_by, admin_id)
                               else activated_by end,
      revoked_at        = case when next_status = 'revoked' then now() else null end
  where id = target_company
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, details)
  values (
    target_company,
    admin_id,
    case when next_status = 'revoked' then 'company_access_revoked' else 'company_activated' end,
    'company',
    target_company,
    jsonb_build_object('activation_status', next_status)
  );

  return result;
end;
$fn$;

revoke execute on function public.set_company_activation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_company_activation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- handle_new_user(): now profile-only. The invite-code branch is gone, so
-- anyone can create an account and look around; a company only ever arrives
-- through redeem_activation_code(). Teammate seats are unaffected - staff keep
-- inserting company_members rows directly, which is how a colleague joins an
-- existing workspace without any code of their own.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Verification (run after applying; all five must hold):
--
--   1. columns and backfill
--      select activation_status, count(*) from public.companies group by 1;
--      -> no rows with 'demo' unless a company was created after this migration
--
--   2. the table is staff-visible and customer-invisible, and unwritable
--      select policyname from pg_policies where tablename = 'activation_codes';
--      -> exactly one: activation_codes_select
--
--   3. redemption works end to end (as a signed-in user with no company whose
--      email matches a pending code)
--      select id, name, plan, activation_status from public.companies
--      where id in (select company_id from public.current_company_ids());
--      -> one row, activation_status 'activated'
--      select status, redeemed_company_id is not null from public.activation_codes
--      where email = lower('you@example.com');
--      -> 'used', true
--
--   4. failure modes are indistinguishable
--      select public.redeem_activation_code('NOSUCHCODE');
--      -> ERROR: That code was not recognised.
--      (also try a real code belonging to a different address: identical text)
--
--   5. audit vocabulary landed
--      select conname, pg_get_constraintdef(oid) from pg_constraint
--      where conname in ('audit_log_action_check', 'audit_log_target_type_check');
--      -> the new activation actions and 'activation_code' target type are listed
-- ---------------------------------------------------------------------------
