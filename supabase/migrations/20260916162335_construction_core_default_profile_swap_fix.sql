-- Fixes a re-review finding on top of construction_core_security_fix: the
-- row-level requirement_profiles_block_removing_last_default trigger made it
-- structurally impossible to ever swap which profile is a company's default
-- (promote-first collides with the unique index, demote-first is blocked by
-- the trigger itself, and even a single atomic UPDATE touching both rows was
-- blocked because a row-level BEFORE trigger has no visibility into a
-- sibling row changing in the same statement). Confirmed live, three ways,
-- all blocked, before this fix.
--
-- Fix has two parts:
--   1. Replace the plain partial unique index with a DEFERRABLE EXCLUDE
--      constraint (partial unique indexes cannot be made deferrable; EXCLUDE
--      is the construct that supports both a WHERE predicate and
--      DEFERRABLE). Checked at commit against the final state, not per row
--      mid-statement, which is what lets a single atomic swap UPDATE
--      succeed.
--   2. Replace the row-level BEFORE trigger with a statement-level AFTER
--      trigger (with a transition table) that checks the NET state once the
--      whole statement has applied - still catches a bare demote/delete with
--      nothing promoted to replace it, but no longer blocks an atomic swap.

-- ---------------------------------------------------------------------------
-- 1. "At most one" - deferrable exclusion constraint replaces the index
-- ---------------------------------------------------------------------------

drop index public.requirement_profiles_one_default_per_company;

alter table public.requirement_profiles
  add constraint requirement_profiles_one_default_per_company
  exclude using btree (company_id with =)
  where (is_company_default)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- seed_company_default_requirement_profile(): ON CONFLICT -> NOT EXISTS
-- ---------------------------------------------------------------------------
-- Postgres cannot infer a deferrable constraint as an ON CONFLICT target, so
-- the seeding trigger switches to a plain existence guard. Fires once per new
-- company row, so there is no realistic concurrent-insert race here.

create or replace function public.seed_company_default_requirement_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.requirement_profiles (company_id, name, is_company_default)
  select new.id, 'Company Default', true
  where not exists (
    select 1 from public.requirement_profiles
    where company_id = new.id and is_company_default
  );
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 2. "At least one" - statement-level AFTER trigger replaces the row-level one
-- ---------------------------------------------------------------------------

drop trigger requirement_profiles_block_removing_last_default on public.requirement_profiles;
drop function public.assert_not_last_default_requirement_profile();

create or replace function public.assert_company_still_has_default_requirement_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  affected_company uuid;
begin
  for affected_company in
    select distinct company_id from old_rows where is_company_default
  loop
    continue when not exists (select 1 from public.companies where id = affected_company);

    if not exists (
      select 1 from public.requirement_profiles
      where company_id = affected_company and is_company_default
    ) then
      raise exception
        'company % must always have exactly one default requirement profile - promote a replacement before removing this one',
        affected_company using errcode = '23514';
    end if;
  end loop;

  return null;
end;
$fn$;

-- One trigger per event: Postgres does not allow a transition table on a
-- trigger covering more than one event.
create trigger requirement_profiles_require_default_after_update
  after update on public.requirement_profiles
  referencing old table as old_rows
  for each statement
  execute function public.assert_company_still_has_default_requirement_profile();

create trigger requirement_profiles_require_default_after_delete
  after delete on public.requirement_profiles
  referencing old table as old_rows
  for each statement
  execute function public.assert_company_still_has_default_requirement_profile();

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------

revoke execute on function public.assert_company_still_has_default_requirement_profile() from public, anon, authenticated;
