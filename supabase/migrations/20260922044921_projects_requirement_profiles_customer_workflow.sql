-- Customer Projects and Requirement Profiles workflow.
--
-- This is intentionally additive: construction-core remains the authoritative
-- project/assignment/profile model and resolve_assignment_requirements() keeps
-- its existing precedence semantics.

alter table public.projects
  add column location text not null default '';

alter table public.requirement_profiles
  add column archived_at timestamptz;

create index requirement_profiles_active_company_name_idx
  on public.requirement_profiles (company_id, name)
  where archived_at is null;

create or replace function public.assert_active_requirement_profile_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  selected_profile_id uuid;
begin
  selected_profile_id := nullif(
    to_jsonb(new) ->> case
      when tg_table_name = 'projects' then 'default_requirement_profile_id'
      else 'requirement_profile_id'
    end,
    ''
  )::uuid;

  if selected_profile_id is not null and exists (
    select 1
    from public.requirement_profiles profile
    where profile.id = selected_profile_id
      and profile.archived_at is not null
  ) then
    raise exception 'An archived requirement profile cannot be selected';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_active_requirement_profile_reference() from public, anon, authenticated;

create trigger projects_require_active_requirement_profile
before insert or update of default_requirement_profile_id on public.projects
for each row execute function public.assert_active_requirement_profile_reference();

create trigger assignments_require_active_requirement_profile
before insert or update of requirement_profile_id on public.project_vendor_assignments
for each row execute function public.assert_active_requirement_profile_reference();

create or replace function public.assert_default_requirement_profile_not_archived()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.archived_at is not null and old.archived_at is null and new.is_company_default then
    raise exception 'The company default requirement profile cannot be archived';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.assert_default_requirement_profile_not_archived() from public, anon, authenticated;

create trigger requirement_profiles_prevent_default_archive
before update of archived_at on public.requirement_profiles
for each row execute function public.assert_default_requirement_profile_not_archived();
