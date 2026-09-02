-- Phase 3 / migration 8 - the compliance engine's audit trail on vendor_documents.
--
-- No new tables. vendor_policies already provides policy history: a renewal
-- supersedes the old row (status -> 'superseded') rather than overwriting or
-- deleting it, so "was this vendor insured on date X" is already answerable
-- without a separate policy_versions table.
--
-- What's missing is linking a document back to what the compliance engine
-- decided about it - which policy row it produced or updated, and why a
-- document that extracted cleanly still needs a human decision instead of an
-- automatic one.

alter table public.vendor_documents
  add column applied_policy_id uuid references public.vendor_policies (id) on delete set null,
  add column review_reason text;

comment on column public.vendor_documents.applied_policy_id is
  'The vendor_policies row this document''s extraction created or renewed, when the compliance engine auto-applied it. Null if nothing was applied - either extraction did not reach processed, or matchExtractedPolicy() (src/workflows/complianceEngine.ts) required a human decision.';

comment on column public.vendor_documents.review_reason is
  'Why processing_status is needs_review, when the reason is a business-rule decision (no matching existing policy to renew, carrier/policy number changed, an unrecognized coverage type) rather than a raw extraction failure. Null otherwise - including when review is needed purely for low extraction confidence, which processing_error already explains.';

-- ---------------------------------------------------------------------------
-- apply_policy_renewal - the only path that turns an extraction into a
-- vendor_policies write
-- ---------------------------------------------------------------------------

-- Superseding the old row and inserting the new one must happen together: the
-- table's own vendor_policies_one_active_per_type unique index (see migration
-- 2) allows only one 'active' row per (vendor_id, policy_type), so if the
-- insert failed after a separate, already-committed UPDATE, the vendor would
-- be left with zero active policies of that type until someone noticed. One
-- RPC call is one transaction from PostgREST's side, so both statements
-- commit or neither does.
--
-- Deliberately NOT security definer. Every statement inside runs with the
-- CALLER's own row-level permissions - the same can_write_company() RLS
-- policy that gates a direct vendor_policies write gates this too. An admin
-- without write access on this vendor cannot get a policy update through by
-- calling the function instead of writing the rows directly; the service
-- role client used by the vendor-portal endpoints bypasses RLS as it already
-- does everywhere else in this schema, not because of anything special here.
create or replace function public.apply_policy_renewal(
  p_company_id uuid,
  p_vendor_id uuid,
  p_existing_policy_id uuid,
  p_policy_type text,
  p_carrier_name text,
  p_policy_number text,
  p_effective_date date,
  p_expiration_date date,
  p_each_occurrence_limit bigint,
  p_general_aggregate_limit bigint,
  p_additional_insured boolean,
  p_waiver_of_subrogation boolean
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  new_policy_id uuid;
begin
  update public.vendor_policies
  set status = 'superseded'
  where id = p_existing_policy_id and vendor_id = p_vendor_id and status = 'active';

  insert into public.vendor_policies (
    company_id, vendor_id, policy_type, carrier_name, policy_number,
    effective_date, expiration_date, each_occurrence_limit, general_aggregate_limit,
    additional_insured, waiver_of_subrogation, status, verification_status
  ) values (
    p_company_id, p_vendor_id, p_policy_type, p_carrier_name, p_policy_number,
    p_effective_date, p_expiration_date, p_each_occurrence_limit, p_general_aggregate_limit,
    p_additional_insured, p_waiver_of_subrogation, 'active', 'verified'
  )
  returning id into new_policy_id;

  return new_policy_id;
end;
$fn$;

-- Matches the Phase 0 hardening lesson exactly: name the roles, never rely on
-- "from public" alone.
revoke execute on function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean
) from public, anon;
grant execute on function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean
) to authenticated, service_role;
