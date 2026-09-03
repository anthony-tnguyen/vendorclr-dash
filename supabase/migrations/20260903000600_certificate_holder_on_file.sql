-- Phase 4 / migration 20 - surface who's actually named as certificate
-- holder on a vendor's current policy, not just that coverage exists.
--
-- Every certificate of insurance names a "certificate holder" at the
-- bottom - typically whichever client/GC required the coverage in the
-- first place. Extraction (documentExtraction.ts) has captured this since
-- Phase 2 (InsuranceExtractionSchema's top-level certificate_holder.name/
-- address), but until now it only ever lived inside
-- vendor_documents.parsed_data - a per-document JSON blob nothing but the
-- review screen ever read. A company auditing whether its own vendors
-- actually named it correctly on their certificates (right legal name, not
-- some other client entirely, not a typo) had no way to see this without
-- opening a document's raw JSON by hand.
--
-- Denormalised onto vendor_policies, same reasoning carrier_name/
-- policy_number already live there rather than only in parsed_data: this is
-- a durable fact about "the current policy on file," not something to
-- re-derive from a document blob on every read. Written by
-- apply_policy_renewal() alongside everything else a renewal sets - both
-- the automated match path (applyComplianceEngine(), vendorUploadRequests.ts)
-- and a human's review-screen approval (resolveReviewItem(),
-- documentReview.ts) go through that one function, so there is no second
-- place this can drift out of sync with what was actually extracted.
--
-- Nullable, not a placeholder default: a policy created before this
-- migration, or one whose extraction never read a certificate holder, is
-- genuinely "not known" - the vendor detail page renders that as "Not on
-- file" (src/data/supabaseRepository.ts), the same missing-data convention
-- every other optional field on Vendor already follows.

alter table public.vendor_policies
  add column certificate_holder_name text,
  add column certificate_holder_address text;

comment on column public.vendor_policies.certificate_holder_name is
  'Who the certificate names as certificate holder, from the extraction that produced this policy row (InsuranceExtractionSchema.certificate_holder.name). Null if extraction never ran, or ran but could not read a name. Shown on the vendor detail page so a company can check its own vendors actually named it correctly, not just that coverage exists.';

comment on column public.vendor_policies.certificate_holder_address is
  'Companion to certificate_holder_name - the address half of the same certificate_holder field.';

-- apply_policy_renewal() gains two parameters. create or replace cannot
-- widen a function's own parameter list in place - Postgres would create a
-- second, overloaded 12-arg function alongside this one rather than
-- actually replacing it - so the old signature is dropped first.
drop function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean
);

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
  p_waiver_of_subrogation boolean,
  p_certificate_holder_name text,
  p_certificate_holder_address text
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
    additional_insured, waiver_of_subrogation, certificate_holder_name,
    certificate_holder_address, status, verification_status
  ) values (
    p_company_id, p_vendor_id, p_policy_type, p_carrier_name, p_policy_number,
    p_effective_date, p_expiration_date, p_each_occurrence_limit, p_general_aggregate_limit,
    p_additional_insured, p_waiver_of_subrogation, p_certificate_holder_name,
    p_certificate_holder_address, 'active', 'verified'
  )
  returning id into new_policy_id;

  return new_policy_id;
end;
$fn$;

-- Same deliberately-not-security-definer reasoning as the original
-- migration 8 grant: every statement inside runs with the CALLER's own
-- row-level permissions, so this widened signature needs the exact same
-- explicit-role regrant migration 8 already established the pattern for.
revoke execute on function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean, text, text
) from public, anon;
grant execute on function public.apply_policy_renewal(
  uuid, uuid, uuid, text, text, text, date, date, bigint, bigint, boolean, boolean, text, text
) to authenticated, service_role;
