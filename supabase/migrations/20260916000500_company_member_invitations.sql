-- Task 6 - company teammate invitations and access lifecycle.
--
-- Distinct from signup_invites (migration 20260915000100): that table gates
-- creating a brand-new *company*. This is about inviting a teammate to an
-- *existing* company, and separately managing existing company_members
-- (role changes, removal) with a last-active-owner guard.
--
-- ---------------------------------------------------------------------------
-- company_members: add soft-removal columns.
-- ---------------------------------------------------------------------------
--
-- "removal deactivates membership" (task checklist) - a removed member's row
-- is kept (audit_log already records the mutation, but keeping the row too
-- means a re-invite/reactivation does not need to reconstruct history) and
-- current_company_ids()/has_company_role()/shares_company_with() below are
-- updated to exclude a deactivated row, so a deactivated member loses access
-- to every RLS-gated table in this schema, not just company_members itself.

alter table public.company_members
  add column deactivated_at timestamptz,
  add column deactivated_by uuid references auth.users (id) on delete set null;

comment on column public.company_members.deactivated_at is
  'Set by remove_company_member(). A non-null value means this member has been removed - excluded from current_company_ids()/has_company_role()/shares_company_with() and the last-active-owner count, but the row is kept for audit history.';

create or replace function public.current_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select company_id
  from public.company_members
  where user_id = (select auth.uid())
    and deactivated_at is null;
$fn$;

create or replace function public.has_company_role(target_company uuid, allowed text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
    from public.company_members
    where user_id = (select auth.uid())
      and company_id = target_company
      and role = any (allowed)
      and deactivated_at is null
  );
$fn$;

create or replace function public.shares_company_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
    from public.company_members m
    where m.user_id = target_user
      and m.deactivated_at is null
      and m.company_id in (select public.current_company_ids())
  );
$fn$;

-- ---------------------------------------------------------------------------
-- Last-active-owner guard.
--
-- Statement-level (not row-level): a row-level BEFORE trigger checking "does
-- at least one other active owner exist" for each individual row would also
-- block a legitimate single-statement ownership transfer (promote a new
-- owner and demote the outgoing one in one UPDATE - see
-- transfer_company_ownership() below), because at the moment each row is
-- evaluated the other row's change has not been applied yet. Checking net
-- post-statement state instead - the same fix class Task 4 used for "last
-- default requirement profile" - allows that atomic transfer while still
-- blocking a statement that would leave zero active owners.
--
-- Fires on UPDATE OR DELETE only: INSERT can never remove an owner. Scoped
-- to companies where an OLD row had role = 'owner' (the only rows whose
-- change could possibly reduce the active-owner count) rather than checking
-- every affected company, so an unrelated bulk update to non-owner rows
-- never pays for the check.
-- ---------------------------------------------------------------------------

create or replace function public.company_members_guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  affected_company uuid;
begin
  for affected_company in
    select distinct company_id from old_rows where role = 'owner'
  loop
    -- Skip a company that no longer exists at all: a DELETE FROM companies
    -- cascades into company_members and fires this same trigger, and
    -- "zero owners remain" is not a real invariant violation when the
    -- company itself is being removed in the same statement (seed.sql's
    -- re-seed does exactly this). Only enforce the invariant for a company
    -- that is still around afterward.
    if exists (select 1 from public.companies where id = affected_company)
       and not exists (
         select 1
         from public.company_members
         where company_id = affected_company
           and role = 'owner'
           and deactivated_at is null
       )
    then
      raise exception 'cannot remove or demote the last active owner of a company'
        using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$fn$;

-- Two triggers, not one "after update or delete": Postgres does not allow a
-- single trigger's REFERENCING clause to span more than one event.
create trigger company_members_guard_last_owner_update_trg
  after update on public.company_members
  referencing old table as old_rows
  for each statement
  execute function public.company_members_guard_last_owner();

create trigger company_members_guard_last_owner_delete_trg
  after delete on public.company_members
  referencing old table as old_rows
  for each statement
  execute function public.company_members_guard_last_owner();

revoke execute on function public.company_members_guard_last_owner() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- audit_log: widen action/target_type for the new mutations this task adds.
-- ---------------------------------------------------------------------------

alter table public.audit_log
  drop constraint audit_log_action_check;

alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
    'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
    'member_role_changed', 'member_removed'
  ));

alter table public.audit_log
  drop constraint audit_log_target_type_check;

alter table public.audit_log
  add constraint audit_log_target_type_check
  check (target_type in (
    'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
    'company_member', 'company_invitation'
  ));

-- ---------------------------------------------------------------------------
-- company_invitations
-- ---------------------------------------------------------------------------

create table public.company_invitations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  -- Normalized (lower + btrim) on write by every RPC below, mirroring
  -- signup_invites' lower(btrim(...)) pattern - the accept flow compares the
  -- authenticated caller's own email against this column, so both sides must
  -- agree on the same normalization.
  email         text not null,
  role          text not null check (role in ('owner', 'risk_manager', 'project_engineer', 'read_only')),
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  token_hash    text not null unique,
  invited_by    uuid references auth.users (id) on delete set null,
  resend_count  int not null default 0,
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users (id) on delete set null,
  revoked_at    timestamptz,
  revoked_by    uuid references auth.users (id) on delete set null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.company_invitations is
  'Invites a teammate to an EXISTING company (distinct from signup_invites, which gates creating a brand-new company). Rows are never written directly - only through create_company_invitation()/resend_company_invitation()/revoke_company_invitation()/accept_company_invitation() below, all SECURITY DEFINER with their own explicit authorization check, since RLS does not apply inside a SECURITY DEFINER function body (owned by postgres, which has rolbypassrls).';

create index company_invitations_company_idx on public.company_invitations (company_id, status);
create index company_invitations_email_idx on public.company_invitations (email);

create trigger company_invitations_touch_updated_at
  before update on public.company_invitations
  for each row execute function public.touch_updated_at();

alter table public.company_invitations enable row level security;

-- Owner-only in every direction, per the checklist's explicit wording
-- ("Only owners invite/change/remove users" - unlike company_members'
-- write policies, risk_manager is deliberately NOT included here). No
-- insert/update/delete policy: every write goes through a SECURITY DEFINER
-- RPC, same shape as signup_invites/company_feature_flags.
create policy company_invitations_select on public.company_invitations
  for select to authenticated
  using (public.has_company_role(company_id, array['owner']) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- create_company_invitation()
-- ---------------------------------------------------------------------------
--
-- token_hash/expires_at are computed by the caller (src/workflows/
-- companyInvitations.ts, Web-Crypto SHA-256 of a 256-bit token - see
-- uploadTokens.ts's hashToken() for the established pattern) and passed in
-- already-hashed: the plaintext token must never reach the database.
create or replace function public.create_company_invitation(
  target_company  uuid,
  invitee_email   text,
  invitee_role    text,
  p_token_hash    text,
  p_expires_at    timestamptz
)
returns public.company_invitations
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller       uuid := (select auth.uid());
  norm_email   text := lower(btrim(coalesce(invitee_email, '')));
  result       public.company_invitations;
begin
  if not public.has_company_role(target_company, array['owner']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if norm_email = '' or norm_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'a valid email is required' using errcode = '22023';
  end if;

  if invitee_role not in ('owner', 'risk_manager', 'project_engineer', 'read_only') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.company_members cm
    join public.profiles p on p.id = cm.user_id
    where cm.company_id = target_company
      and cm.deactivated_at is null
      and lower(btrim(p.email)) = norm_email
  ) then
    raise exception 'this person is already an active member of the company' using errcode = '23505';
  end if;

  -- Superseding an existing pending invite to the same email keeps at most
  -- one active invite per (company, email) - a fresh invite implicitly
  -- revokes an older un-actioned one rather than leaving both live.
  update public.company_invitations
  set status = 'revoked', revoked_at = now(), revoked_by = caller
  where company_id = target_company
    and email = norm_email
    and status = 'pending';

  insert into public.company_invitations (
    company_id, email, role, token_hash, invited_by, expires_at
  )
  values (target_company, norm_email, invitee_role, p_token_hash, caller, p_expires_at)
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    target_company, caller, 'member_invited', 'company_invitation', result.id,
    jsonb_build_object('email', norm_email, 'role', invitee_role)
  );

  return result;
end;
$fn$;

revoke execute on function public.create_company_invitation(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_company_invitation(uuid, text, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- resend_company_invitation()
-- ---------------------------------------------------------------------------

create or replace function public.resend_company_invitation(
  invitation_id uuid,
  p_token_hash  text,
  p_expires_at  timestamptz
)
returns public.company_invitations
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller  uuid := (select auth.uid());
  invite  public.company_invitations;
  result  public.company_invitations;
begin
  -- Combined into one identical error for "doesn't exist" and "exists but
  -- isn't yours to resend" - same anti-probing discipline as
  -- resolve_assignment_requirements() (construction core migration): a
  -- caller must not be able to distinguish the two by error code/message.
  select * into invite from public.company_invitations where id = invitation_id;
  if invite.id is null or not public.has_company_role(invite.company_id, array['owner']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if invite.status not in ('pending', 'expired') then
    raise exception 'this invitation can no longer be resent - its status is already %', invite.status
      using errcode = '22023';
  end if;

  update public.company_invitations
  set status = 'pending',
      token_hash = p_token_hash,
      expires_at = p_expires_at,
      resend_count = resend_count + 1
  where id = invitation_id
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    result.company_id, caller, 'member_invite_resent', 'company_invitation', result.id,
    jsonb_build_object('email', result.email, 'resendCount', result.resend_count)
  );

  return result;
end;
$fn$;

revoke execute on function public.resend_company_invitation(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.resend_company_invitation(uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- revoke_company_invitation()
-- ---------------------------------------------------------------------------

create or replace function public.revoke_company_invitation(invitation_id uuid)
returns public.company_invitations
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller  uuid := (select auth.uid());
  invite  public.company_invitations;
  result  public.company_invitations;
begin
  -- See resend_company_invitation() above for why "not found" and "not
  -- yours" share one error.
  select * into invite from public.company_invitations where id = invitation_id;
  if invite.id is null or not public.has_company_role(invite.company_id, array['owner']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if invite.status not in ('pending', 'expired') then
    raise exception 'this invitation can no longer be revoked - its status is already %', invite.status
      using errcode = '22023';
  end if;

  update public.company_invitations
  set status = 'revoked', revoked_at = now(), revoked_by = caller
  where id = invitation_id
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    result.company_id, caller, 'member_invite_revoked', 'company_invitation', result.id,
    jsonb_build_object('email', result.email)
  );

  return result;
end;
$fn$;

revoke execute on function public.revoke_company_invitation(uuid) from public, anon, authenticated;
grant execute on function public.revoke_company_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- accept_company_invitation()
--
-- The one function here callable by someone who is NOT yet a member of the
-- target company - has_company_role() cannot gate this the way the other
-- three are gated. The explicit authorization check is instead "the
-- authenticated caller's own email matches the invitation's locked email",
-- read from auth.users (not client input) so it cannot be spoofed.
-- ---------------------------------------------------------------------------

create or replace function public.accept_company_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller       uuid := (select auth.uid());
  caller_email text;
  invite       public.company_invitations;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select email into caller_email from auth.users where id = caller;
  if caller_email is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select * into invite
  from public.company_invitations
  where token_hash = p_token_hash
  for update;

  if invite.id is null then
    raise exception 'this invitation link is no longer valid' using errcode = 'P0002';
  end if;

  -- Deliberately does NOT persist status = 'expired' here: this whole
  -- function runs as one statement, so an UPDATE followed later by the
  -- raise exception below would be rolled back along with everything else -
  -- Postgres has no way to partially commit within a single failed
  -- statement without an explicit savepoint. Lazy expiry is instead computed
  -- at read time (displayStatus() in src/workflows/companyInvitations.ts),
  -- which every list/preview path already goes through - a stale stored
  -- 'pending' row here does not cause a live accept, since the check below
  -- rejects it regardless of the stored column.
  if invite.status <> 'pending' or invite.expires_at < now() then
    raise exception 'this invitation link is no longer valid' using errcode = '22023';
  end if;

  -- The explicit authorization check this function's SECURITY DEFINER body
  -- needs (see docblock above): RLS does not run inside this function, so
  -- nothing else here would otherwise stop a signed-in user from redeeming
  -- someone else's invitation.
  if lower(btrim(caller_email)) <> invite.email then
    raise exception 'this invitation was sent to a different email address' using errcode = '42501';
  end if;

  insert into public.company_members (company_id, user_id, role, last_active_at)
  values (invite.company_id, caller, invite.role, now())
  on conflict (company_id, user_id)
  do update set role = excluded.role, deactivated_at = null, deactivated_by = null, last_active_at = now();

  update public.company_invitations
  set status = 'accepted', accepted_at = now(), accepted_by = caller
  where id = invite.id;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    invite.company_id, caller, 'invite_accepted', 'company_invitation', invite.id,
    jsonb_build_object('email', invite.email, 'role', invite.role)
  );

  return jsonb_build_object('companyId', invite.company_id, 'role', invite.role);
end;
$fn$;

revoke execute on function public.accept_company_invitation(text) from public, anon, authenticated;
grant execute on function public.accept_company_invitation(text) to authenticated;

-- ---------------------------------------------------------------------------
-- change_company_member_role() / remove_company_member() /
-- transfer_company_ownership()
--
-- Even though company_members' own UPDATE/DELETE RLS policies already
-- restrict writes to owners (company_members_update/_delete,
-- has_company_role(..., array['owner'])), these three are still SECURITY
-- DEFINER RPCs rather than bare client UPDATEs: the checklist requires
-- "every access mutation has an audit row ... inside the same
-- transaction/function as the mutation itself", and a client-side UPDATE
-- followed by a second, separate audit_log INSERT from the caller is not
-- atomic - either statement could fail or be skipped independently. Wrapping
-- both in one PL/pgSQL function makes them one transaction. The
-- authorization check here is deliberately re-stated explicitly (not just
-- "RLS will catch it") per the same reasoning as the other functions above.
-- ---------------------------------------------------------------------------

create or replace function public.change_company_member_role(
  target_member_id uuid,
  new_role         text
)
returns public.company_members
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller  uuid := (select auth.uid());
  member  public.company_members;
  result  public.company_members;
begin
  -- See resend_company_invitation() (this migration) for why "not found"
  -- and "not yours" share one error.
  select * into member from public.company_members where id = target_member_id;
  if member.id is null or not public.has_company_role(member.company_id, array['owner']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if new_role not in ('owner', 'risk_manager', 'project_engineer', 'read_only') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  -- company_members_guard_last_owner_trg (above) raises here, aborting this
  -- whole function, if this UPDATE would leave the company with zero active
  -- owners - so no audit row is written for a blocked change.
  update public.company_members
  set role = new_role
  where id = target_member_id
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    result.company_id, caller, 'member_role_changed', 'company_member', result.id,
    jsonb_build_object('previousRole', member.role, 'newRole', new_role, 'userId', result.user_id)
  );

  return result;
end;
$fn$;

revoke execute on function public.change_company_member_role(uuid, text) from public, anon, authenticated;
grant execute on function public.change_company_member_role(uuid, text) to authenticated;

create or replace function public.remove_company_member(target_member_id uuid)
returns public.company_members
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller  uuid := (select auth.uid());
  member  public.company_members;
  result  public.company_members;
begin
  -- See resend_company_invitation() (this migration) for why "not found"
  -- and "not yours" share one error.
  select * into member from public.company_members where id = target_member_id;
  if member.id is null or not public.has_company_role(member.company_id, array['owner']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.company_members
  set deactivated_at = now(), deactivated_by = caller
  where id = target_member_id
  returning * into result;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    result.company_id, caller, 'member_removed', 'company_member', result.id,
    jsonb_build_object('userId', result.user_id, 'previousRole', result.role)
  );

  return result;
end;
$fn$;

revoke execute on function public.remove_company_member(uuid) from public, anon, authenticated;
grant execute on function public.remove_company_member(uuid) to authenticated;

-- Atomic "promote a new owner, demote the outgoing one" in a single UPDATE
-- statement (one CASE'd UPDATE over both rows) - the realistic one-click
-- "transfer ownership" flow a future UI would offer. Deliberately a single
-- UPDATE affecting both rows together, not two sequential
-- change_company_member_role() calls: two sequential calls would each be
-- their own statement, and the first one (demoting the sole existing owner
-- before the new one is promoted) would be correctly rejected by
-- company_members_guard_last_owner_trg as "removing the last active owner" -
-- exactly the false-positive Task 4 hit with "last default requirement
-- profile". This function's single UPDATE lets the statement-level trigger
-- see the net result (still exactly one owner) and allow it.
create or replace function public.transfer_company_ownership(
  from_member_id uuid,
  to_member_id   uuid,
  demoted_role   text default 'risk_manager'
)
returns setof public.company_members
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  caller     uuid := (select auth.uid());
  from_row   public.company_members;
  to_row     public.company_members;
begin
  select * into from_row from public.company_members where id = from_member_id;
  select * into to_row from public.company_members where id = to_member_id;

  if from_row.id is null or to_row.id is null then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if from_row.company_id <> to_row.company_id then
    raise exception 'both members must belong to the same company' using errcode = '22023';
  end if;
  if not public.has_company_role(from_row.company_id, array['owner']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if from_row.role <> 'owner' then
    raise exception 'the outgoing member is not currently an owner' using errcode = '22023';
  end if;
  if demoted_role not in ('owner', 'risk_manager', 'project_engineer', 'read_only') then
    raise exception 'invalid role' using errcode = '22023';
  end if;

  update public.company_members
  set role = case id when to_member_id then 'owner' else demoted_role end
  where id in (from_member_id, to_member_id);

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values
    (from_row.company_id, caller, 'member_role_changed', 'company_member', from_row.id,
     jsonb_build_object('previousRole', 'owner', 'newRole', demoted_role, 'userId', from_row.user_id, 'reason', 'ownership_transfer')),
    (to_row.company_id, caller, 'member_role_changed', 'company_member', to_row.id,
     jsonb_build_object('previousRole', to_row.role, 'newRole', 'owner', 'userId', to_row.user_id, 'reason', 'ownership_transfer'));

  return query select * from public.company_members where id in (from_member_id, to_member_id);
end;
$fn$;

revoke execute on function public.transfer_company_ownership(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.transfer_company_ownership(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_company_stats.seat_count fix
--
-- This view (20260901000300_tasks_queue_leads_and_views.sql) predates
-- deactivated_at and counted every company_members row unconditionally.
-- Removal now soft-deactivates rather than deletes, so left unfixed this
-- would overcount seats by every removed member. create or replace view
-- keeps its oid/dependents stable while updating the definition.
-- ---------------------------------------------------------------------------

create or replace view public.admin_company_stats
with (security_invoker = true) as
select
  c.id,
  c.name,
  c.plan,
  c.subscription_renews_on,
  (select count(*) from public.vendors v
    where v.company_id = c.id and v.archived_at is null)::int as vendor_count,
  (select count(*) from public.company_members m
    where m.company_id = c.id and m.deactivated_at is null)::int as seat_count,
  coalesce((
    select round(100.0 * count(*) filter (where s.fully_compliant) / nullif(count(*), 0))
    from public.vendor_compliance_summary s
    where s.company_id = c.id
  ), 0)::int                                                  as compliance_rate
from public.companies c;
