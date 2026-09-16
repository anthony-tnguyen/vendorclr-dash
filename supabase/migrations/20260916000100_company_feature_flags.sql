-- Per-company kill switches for flows that ship incrementally (construction
-- schema, requirement profiles, team invites, submission packages,
-- deficiency cases, exceptions, reports v2 - none of which exist in the
-- schema yet). All keys default to false; a new company must never be able
-- to enter an unfinished flow just because the code that gates it forgot to
-- check. This migration adds only the switch itself - nothing in the app
-- reads it yet, and no company has any row here after this migration runs.

-- ---------------------------------------------------------------------------
-- company_feature_flags
-- ---------------------------------------------------------------------------

create table public.company_feature_flags (
  company_id uuid not null references public.companies (id) on delete cascade,
  key        text not null check (key in (
    'construction_core',
    'requirement_profiles',
    'team_invites',
    'submission_packages',
    'deficiency_cases',
    'exceptions',
    'reports_v2'
  )),
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (company_id, key)
);

comment on table public.company_feature_flags is
  'Per-company feature kill switches. Absence of a row means the flag reads as disabled - flags default off and a company need not have every key populated. Mutated only through set_company_feature_flag(), never directly; see that function for why.';

-- No separate company_id index: the primary key is (company_id, key), and a
-- btree on a composite key is already ordered by its leading column, so
-- `where company_id = $1` (a full flag set, not just one key) uses the PK
-- index directly. A dedicated company_id-only index would just duplicate it.

create trigger company_feature_flags_touch_updated_at
  before update on public.company_feature_flags
  for each row execute function public.touch_updated_at();

alter table public.company_feature_flags enable row level security;

-- Members read only their own company's flags; platform admins read every
-- company's, same shape as every other tenant-scoped table. No
-- insert/update/delete policy is defined on purpose - see
-- set_company_feature_flag() below, same shape as signup_invites: rows are
-- never written directly, only through the SECURITY DEFINER RPC, so RLS
-- denies every direct write regardless of the caller's company role.
create policy company_feature_flags_select on public.company_feature_flags
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- set_company_feature_flag(): the only way a row is ever written into
-- company_feature_flags. SECURITY DEFINER so it can insert/update despite
-- the table having no write policy; the is_platform_admin() check below is
-- what actually gates it - same shape as create_signup_invite(). Company
-- owners are deliberately NOT granted this: these flags gate incomplete
-- product surfaces being rolled out company-by-company, a platform-staff
-- decision, not a tenant self-service setting.
-- ---------------------------------------------------------------------------

create or replace function public.set_company_feature_flag(
  target_company uuid,
  flag_key       text,
  flag_enabled   boolean
)
returns public.company_feature_flags
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  result public.company_feature_flags;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  insert into public.company_feature_flags (company_id, key, enabled)
  values (target_company, flag_key, flag_enabled)
  on conflict (company_id, key)
  do update set enabled = excluded.enabled, updated_at = now()
  returning * into result;

  return result;
end;
$fn$;

revoke execute on function public.set_company_feature_flag(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.set_company_feature_flag(uuid, text, boolean) to authenticated;
