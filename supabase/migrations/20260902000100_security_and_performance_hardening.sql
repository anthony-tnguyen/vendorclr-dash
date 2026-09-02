-- Hardening pass, driven by Supabase's own advisor after applying migrations
-- 1-4 to a real project (`get_advisors`) rather than assumed. Two categories:
--
--   1. Every function-privilege revoke in migration 1 was silently ineffective.
--      `revoke execute ... from public` only revokes the privilege granted to
--      the special PUBLIC pseudo-role. Supabase's database template applies
--      `alter default privileges in schema public grant execute on functions
--      to anon, authenticated, service_role`, which grants EXECUTE to those
--      roles *directly*, at function-creation time - a separate grant that
--      `revoke ... from public` never touches. Confirmed on the live project:
--      every function below had `has_function_privilege('anon', ..., 'EXECUTE')
--      = true` despite the migration 1 revoke. Fixed here by revoking from the
--      named roles directly.
--
--   2. Four foreign keys with no covering index, and one table with a
--      redundant SELECT policy (compliance_queue_items had both a SELECT
--      policy and a `for all` staff policy that also covered SELECT, so every
--      read evaluated two permissive policies instead of one).

-- ---------------------------------------------------------------------------
-- 1a. touch_updated_at() had no search_path set
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1b. Trigger-only functions: never meant to be called directly by anyone,
-- via RPC or otherwise. Firing as a trigger does not require EXECUTE - only
-- direct invocation does - so revoking it here does not break the triggers
-- that already use these functions.
-- ---------------------------------------------------------------------------

revoke execute on function public.assert_company_matches_vendor() from public, anon, authenticated;
revoke execute on function public.assert_task_company_matches_vendor() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.seed_vendor_compliance_items() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1c. RLS-primitive functions: authenticated genuinely needs EXECUTE (RLS
-- policies invoke these as the querying role, regardless of SECURITY
-- DEFINER), but anon must not be able to call them at all.
-- ---------------------------------------------------------------------------

revoke execute on function public.current_company_ids() from anon;
revoke execute on function public.is_platform_admin() from anon;
revoke execute on function public.has_company_role(uuid, text[]) from anon;
revoke execute on function public.can_write_company(uuid) from anon;
revoke execute on function public.shares_company_with(uuid) from anon;
revoke execute on function public.create_company_for_current_user(text, text) from anon;

-- ---------------------------------------------------------------------------
-- 2a. Unindexed foreign keys
-- ---------------------------------------------------------------------------

create index compliance_queue_items_vendor_idx on public.compliance_queue_items (vendor_id);
create index email_outbox_upload_request_idx on public.email_outbox (upload_request_id);
create index vendor_coverage_limits_company_idx on public.vendor_coverage_limits (company_id);
create index vendor_upload_requests_created_by_idx on public.vendor_upload_requests (created_by);

-- ---------------------------------------------------------------------------
-- 2b. compliance_queue_items: split the `for all` staff policy so SELECT is
-- governed by exactly one permissive policy instead of two.
-- ---------------------------------------------------------------------------

drop policy compliance_queue_items_write on public.compliance_queue_items;

create policy compliance_queue_items_insert on public.compliance_queue_items
  for insert to authenticated
  with check (public.is_platform_admin());

create policy compliance_queue_items_update on public.compliance_queue_items
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

create policy compliance_queue_items_delete on public.compliance_queue_items
  for delete to authenticated
  using (public.is_platform_admin());
