-- Gates self-serve business signup behind an admin-issued, per-company,
-- email-locked invite code. See
-- docs/superpowers/specs/2026-09-15-gated-signup-invites-design.md for the
-- approved design this migration implements.

-- ---------------------------------------------------------------------------
-- signup_invites
-- ---------------------------------------------------------------------------

create table public.signup_invites (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  email         text not null,
  company_name  text not null check (length(btrim(company_name)) between 1 and 200),
  status        text not null default 'pending' check (status in ('pending', 'used', 'revoked')),
  expires_at    timestamptz not null,
  created_by    uuid references public.platform_admins (user_id) on delete set null,
  used_at       timestamptz,
  used_by       uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (code)
);

comment on table public.signup_invites is
  'Admin-issued, email-locked, single-use codes gating self-serve business signup. Redeemed by handle_new_user() during the auth.users insert.';

create trigger signup_invites_touch_updated_at
  before update on public.signup_invites
  for each row execute function public.touch_updated_at();

-- Generates a unique code and a 14-day expiry when the caller does not
-- supply one, and normalizes the email so the lookup in handle_new_user()
-- (added in the next migration) is case-insensitive.
create or replace function public.set_signup_invite_defaults()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  candidate text;
  attempts  int := 0;
begin
  new.email := lower(btrim(new.email));

  if new.code is null then
    loop
      candidate := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
      exit when not exists (select 1 from public.signup_invites where code = candidate);
      attempts := attempts + 1;
      if attempts > 5 then
        raise exception 'Could not generate a unique invite code';
      end if;
    end loop;
    new.code := candidate;
  else
    new.code := upper(btrim(new.code));
  end if;

  if new.expires_at is null then
    new.expires_at := now() + interval '14 days';
  end if;

  return new;
end;
$fn$;

create trigger signup_invites_set_defaults
  before insert on public.signup_invites
  for each row execute function public.set_signup_invite_defaults();

alter table public.signup_invites enable row level security;

-- Admin-only in every direction. Rows are never inserted directly by a
-- client - only through create_signup_invite() below - so there is
-- deliberately no insert policy; RLS denies insert to authenticated by
-- default with none defined.
create policy signup_invites_select on public.signup_invites
  for select to authenticated
  using (public.is_platform_admin());

create policy signup_invites_update on public.signup_invites
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- create_signup_invite(): the only way a row is ever inserted into
-- signup_invites. SECURITY DEFINER so it can insert despite the table
-- having no insert policy; the is_platform_admin() check below is what
-- actually gates it - same shape as create_company_for_current_user().
-- ---------------------------------------------------------------------------

create or replace function public.create_signup_invite(
  company_name text,
  email        text
)
returns public.signup_invites
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  result   public.signup_invites;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if length(btrim(coalesce(company_name, ''))) = 0 then
    raise exception 'company_name is required' using errcode = '22023';
  end if;
  if length(btrim(coalesce(email, ''))) = 0 then
    raise exception 'email is required' using errcode = '22023';
  end if;

  insert into public.signup_invites (company_name, email, created_by)
  values (btrim(company_name), email, admin_id)
  returning * into result;

  return result;
end;
$fn$;

revoke execute on function public.create_signup_invite(text, text) from public, anon, authenticated;
grant execute on function public.create_signup_invite(text, text) to authenticated;

revoke execute on function public.set_signup_invite_defaults() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- handle_new_user(): now redeems an invite code before creating a company.
-- Company creation used to be conditional on a client-supplied
-- company_name; it is now conditional on a client-supplied invite_code that
-- resolves to a pending, unexpired, email-matching invite. A missing,
-- invalid, expired, revoked or already-used code raises, which aborts the
-- whole auth.users insert - signUp() fails and no account is created.
--
-- No code at all still creates the profile with no company, same as
-- today's no-company_name path. That path is intentionally left open: it is
-- how a teammate is added to an *existing* company (direct company_members
-- insert, not through /signup), which this gate is not meant to cover - see
-- the "Non-goals" section of the design doc.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  requested_code text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')), '');
  invite         public.signup_invites;
  new_company    uuid;
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  if requested_code is not null then
    select * into invite
    from public.signup_invites
    where code = upper(requested_code)
      and status = 'pending'
    for update;

    if invite.id is null
       or invite.expires_at < now()
       or invite.email <> lower(new.email)
    then
      raise exception 'Invalid or expired invite code.';
    end if;

    insert into public.companies (name)
    values (left(invite.company_name, 200))
    returning id into new_company;

    insert into public.company_members (company_id, user_id, role, last_active_at)
    values (new_company, new.id, 'owner', now())
    on conflict (company_id, user_id) do nothing;

    update public.signup_invites
    set status = 'used', used_at = now(), used_by = new.id
    where id = invite.id;
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- create_company_for_current_user() bypassed the invite gate entirely - any
-- authenticated user could call it directly and get a company with no code
-- at all. It is not called anywhere in the app today (supabaseRepository.ts
-- only names it in an error message), so revoking EXECUTE closes the hole
-- without breaking anything that calls it.
-- ---------------------------------------------------------------------------

revoke execute on function public.create_company_for_current_user(text, text) from authenticated;
