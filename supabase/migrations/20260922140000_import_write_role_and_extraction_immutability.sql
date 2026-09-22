-- Pilot blockers (reports/import/review UI) - two small backend corrections
-- found while wiring the customer-facing UI onto existing server functions.
--
-- 1. import_vendor_row() authorized callers with current_company_ids() -
--    ANY member of the company, including a 'read_only' one. Every direct
--    write policy on projects/vendors/project_vendor_assignments uses
--    can_write_company() (owner/risk_manager/project_engineer), and so does
--    vendor_import_batches_insert - but because this function is SECURITY
--    DEFINER, a read_only member could still create projects, vendors and
--    assignments through it; only the batch-summary insert afterwards failed.
--    The bulk import is now exposed in the customer UI, so the function's own
--    check is aligned with the write policies. Body otherwise unchanged from
--    20260917001500_vendor_import.sql.
--
-- 2. document_extractions is documented (20260917000900) as immutable and
--    append-only - a reviewer's correction is a NEW 'reviewer_edit' row and
--    never overwrites the model's own row - but nothing in the database
--    enforced it: the service role (which saveExtractionEdit() uses) bypasses
--    RLS entirely. A BEFORE UPDATE trigger now rejects every update. DELETE is
--    deliberately left alone so the on-delete-cascade from vendor_documents
--    (customer deletion, Task 12) keeps working.

create or replace function public.import_vendor_row(
  p_company_id                  uuid,
  p_project_name                text,
  p_certificate_holder_name     text,
  p_certificate_holder_address  text,
  p_vendor_name                 text,
  p_trade                       text,
  p_contact_name                text,
  p_contact_email               text,
  p_risk_tier                   text,
  p_contract_value              bigint,
  out project_id                uuid,
  out project_created           boolean,
  out vendor_id                 uuid,
  out vendor_created             boolean,
  out assignment_id             uuid,
  out assignment_created        boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_project_name  text := btrim(p_project_name);
  v_vendor_name   text := btrim(p_vendor_name);
  v_norm_email    text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  -- Local working variables, not the OUT parameters directly: several of
  -- these share a bare name with a column on the table being queried
  -- (project_id/vendor_id), which would make plpgsql's default
  -- variable-over-column resolution silently shadow the column reference in
  -- a WHERE clause. Using v_-prefixed locals throughout the body and only
  -- assigning to the OUT parameters at the very end avoids that ambiguity
  -- entirely rather than relying on plpgsql.variable_conflict configuration.
  v_project_id         uuid;
  v_project_created    boolean;
  v_vendor_id          uuid;
  v_vendor_created     boolean;
  v_assignment_id      uuid;
  v_assignment_created boolean;
begin
  if not (
    public.can_write_company(p_company_id)
    or public.is_platform_admin()
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if length(v_project_name) = 0 then
    raise exception 'project name is required' using errcode = '22023';
  end if;
  if length(v_vendor_name) = 0 then
    raise exception 'vendor name is required' using errcode = '22023';
  end if;

  -- Project: lookup by normalized (trimmed) name first, matching
  -- projects' own `unique (company_id, name)` natural key.
  select p.id into v_project_id
  from public.projects p
  where p.company_id = p_company_id and btrim(p.name) = v_project_name;

  if found then
    v_project_created := false;
  else
    insert into public.projects (
      company_id, name, certificate_holder_name, certificate_holder_address
    ) values (
      p_company_id, v_project_name,
      coalesce(btrim(p_certificate_holder_name), ''),
      coalesce(btrim(p_certificate_holder_address), '')
    )
    returning id into v_project_id;
    v_project_created := true;
  end if;

  -- Vendor: lookup by normalized name OR normalized non-empty email -
  -- either match means "this is the same vendor", so neither branch
  -- overwrites the existing row's other fields.
  select v.id into v_vendor_id
  from public.vendors v
  where v.company_id = p_company_id
    and (
      lower(btrim(v.name)) = lower(v_vendor_name)
      or (v_norm_email is not null and lower(btrim(v.contact_email)) = v_norm_email)
    )
  order by v.created_at asc
  limit 1;

  if found then
    v_vendor_created := false;
  else
    insert into public.vendors (
      company_id, name, trade, contact_name, contact_email, risk_tier, contract_value
    ) values (
      p_company_id, v_vendor_name,
      coalesce(p_trade, 'Structural Steel'),
      coalesce(btrim(p_contact_name), ''),
      coalesce(btrim(p_contact_email), ''),
      coalesce(p_risk_tier, 'moderate'),
      coalesce(p_contract_value, 0)
    )
    returning id into v_vendor_id;
    v_vendor_created := true;
  end if;

  -- Assignment: an existing (project, vendor) pair is a success no-op, not
  -- an error - re-running the same CSV, or two rows naming the same vendor
  -- for the same project, must not fail here.
  select a.id into v_assignment_id
  from public.project_vendor_assignments a
  where a.project_id = v_project_id and a.vendor_id = v_vendor_id;

  if found then
    v_assignment_created := false;
  else
    insert into public.project_vendor_assignments (
      company_id, project_id, vendor_id, contract_value, trade_code, risk_classification
    ) values (
      p_company_id, v_project_id, v_vendor_id, p_contract_value, p_trade, p_risk_tier
    )
    returning id into v_assignment_id;
    v_assignment_created := true;
  end if;

  project_id := v_project_id;
  project_created := v_project_created;
  vendor_id := v_vendor_id;
  vendor_created := v_vendor_created;
  assignment_id := v_assignment_id;
  assignment_created := v_assignment_created;

  return;
end;
$fn$;

revoke execute on function public.import_vendor_row(
  uuid, text, text, text, text, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.import_vendor_row(
  uuid, text, text, text, text, text, text, text, text, bigint
) to authenticated;

-- ---------------------------------------------------------------------------
-- document_extractions: reject every UPDATE
-- ---------------------------------------------------------------------------

create or replace function public.reject_document_extraction_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'document_extractions rows are immutable - record a new revision with record_document_extraction() instead'
    using errcode = '55000';
end;
$fn$;

revoke execute on function public.reject_document_extraction_update() from public, anon, authenticated;

create trigger document_extractions_immutable
  before update on public.document_extractions
  for each row execute function public.reject_document_extraction_update();
