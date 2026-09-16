-- Task 8a - multi-file submission packages: checklist items, a document-kind
-- vocabulary, package versioning, and document-level replacement lineage.
--
-- Domain model this migration builds:
--
--   vendor_upload_requests ──< upload_request_checklist_items
--                          ──< submission_packages ──< package_documents >── vendor_documents
--
-- upload_request_checklist_items says WHAT is required for one upload
-- request (e.g. "Certificate of Insurance", required; "Additional Insured
-- Endorsement", required) - company-configurable checklists are a later
-- task, so for now this is just a flat list written once when the request
-- is created (see finalizePackage()/createPackage() in
-- src/workflows/submissionPackages.ts for who writes it).
--
-- submission_packages is one open/finalized package per vendor per upload
-- request, VERSIONED: a resubmission after a deficiency
-- (replaceDeficientDocument()) creates a new package VERSION - a new row,
-- linked back via previous_package_id, with the earlier version marked
-- 'superseded' - not a brand new package disconnected from the original
-- case. Only one package may be 'open' per upload request at a time
-- (submission_packages_one_open_per_request below), which is what makes
-- "one per vendor per upload request" true at any given moment even though
-- several historical versions can exist.
--
-- package_documents links a package version to the vendor_documents rows
-- that satisfy it. A resubmission that only replaces one deficient file
-- does NOT require re-uploading the rest: the new package version's
-- package_documents rows for every OTHER checklist item point at the exact
-- same vendor_documents rows the previous version used - only the replaced
-- slot points at a new document. See replaceDeficientDocument() for how
-- this is assembled.
--
-- Replacement lineage: vendor_documents.replaces_document_id (added at the
-- bottom of this migration) records which specific document a corrected
-- upload supersedes. This is deliberately a NEW column, not a reuse of the
-- existing vendor_documents.duplicate_of_document_id (migration 12/
-- document_extraction): duplicate_of_document_id means "these are the exact
-- same bytes" (same sha256, used to skip re-running extraction on an
-- identical file re-uploaded for a different vendor/purpose).
-- replaces_document_id means the opposite kind of thing - "this is a
-- DIFFERENT file (a corrected one) that stands in for a deficient
-- predecessor in the same package lineage." Conflating the two would make
-- duplicate-detection logic (which assumes identical content) silently
-- misfire against a replacement upload that is deliberately different
-- content.

-- ---------------------------------------------------------------------------
-- upload_request_checklist_items
-- ---------------------------------------------------------------------------

create table public.upload_request_checklist_items (
  id                 uuid primary key default gen_random_uuid(),
  -- Denormalised from vendor_upload_requests, same reasoning as every other
  -- upload-request-scoped table in this schema: RLS stays one indexed
  -- predicate, kept honest by assert_company_matches_upload_request() below.
  company_id         uuid not null references public.companies (id) on delete cascade,
  vendor_id          uuid not null references public.vendors (id) on delete cascade,
  upload_request_id  uuid not null references public.vendor_upload_requests (id) on delete cascade,
  -- The document-kind vocabulary. Kept in sync by hand across this table and
  -- package_documents below - see this migration's docblock for why a
  -- shared Postgres domain wasn't used (this schema's established pattern,
  -- per vendors.trade/vendor_policies.policy_type, is an inline CHECK per
  -- column, not a CREATE DOMAIN).
  document_kind      text not null check (document_kind in (
                        'certificate_of_insurance',
                        'additional_insured_endorsement',
                        'waiver_of_subrogation_endorsement',
                        'primary_noncontributory_endorsement',
                        'other'
                      )),
  is_required        boolean not null default true,
  created_at         timestamptz not null default now(),
  -- One checklist line per document kind per upload request - "Certificate
  -- of Insurance" cannot be listed twice with conflicting required-ness.
  unique (upload_request_id, document_kind)
);

create index upload_request_checklist_items_request_idx
  on public.upload_request_checklist_items (upload_request_id);
create index upload_request_checklist_items_company_idx
  on public.upload_request_checklist_items (company_id);

-- ---------------------------------------------------------------------------
-- submission_packages
-- ---------------------------------------------------------------------------

create table public.submission_packages (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete cascade,
  vendor_id            uuid not null references public.vendors (id) on delete cascade,
  upload_request_id    uuid not null references public.vendor_upload_requests (id) on delete cascade,
  version              integer not null default 1 check (version > 0),
  status               text not null default 'open' check (status in ('open', 'finalized', 'superseded')),
  -- The package version this one supersedes, when it exists - null for the
  -- first version of a package. Set by replaceDeficientDocument().
  previous_package_id  uuid references public.submission_packages (id) on delete set null,
  finalized_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (upload_request_id, version)
);

create index submission_packages_request_idx on public.submission_packages (upload_request_id);
create index submission_packages_vendor_idx on public.submission_packages (vendor_id);
create index submission_packages_company_idx on public.submission_packages (company_id);

-- At most one OPEN package per upload request at any moment - what actually
-- makes "one per vendor per upload request" true despite several historical
-- versions existing. A plain unique index (not an "at least one X" trigger)
-- is the right tool here: this is a per-row uniqueness constraint Postgres
-- enforces natively, not the "at least one row must remain after a
-- multi-row statement" shape that bit Task 4 and needed a statement-level
-- AFTER trigger to fix.
create unique index submission_packages_one_open_per_request
  on public.submission_packages (upload_request_id)
  where status = 'open';

create trigger submission_packages_touch_updated_at
  before update on public.submission_packages
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- package_documents - links a package version to the documents that satisfy it
-- ---------------------------------------------------------------------------

create table public.package_documents (
  id             uuid primary key default gen_random_uuid(),
  -- Denormalised from submission_packages, same one-indexed-predicate
  -- reasoning as above.
  company_id     uuid not null references public.companies (id) on delete cascade,
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  package_id     uuid not null references public.submission_packages (id) on delete cascade,
  document_id    uuid not null references public.vendor_documents (id) on delete cascade,
  -- Which checklist slot this document fills in this package version. Not a
  -- foreign key to upload_request_checklist_items.id on purpose: a
  -- checklist item is shared across every version of a package's lineage,
  -- while a package_documents row belongs to exactly one version - matching
  -- on document_kind (the same vocabulary both tables share) is what lets
  -- finalizePackage() ask "does every required checklist item have a
  -- matching package_documents row in THIS version" without the checklist
  -- itself needing to be copied per version.
  document_kind  text not null check (document_kind in (
                    'certificate_of_insurance',
                    'additional_insured_endorsement',
                    'waiver_of_subrogation_endorsement',
                    'primary_noncontributory_endorsement',
                    'other'
                  )),
  created_at     timestamptz not null default now(),
  -- The same document cannot be linked into one package version twice.
  unique (package_id, document_id)
);

create index package_documents_package_idx on public.package_documents (package_id);
create index package_documents_document_idx on public.package_documents (document_id);
create index package_documents_company_idx on public.package_documents (company_id);

-- ---------------------------------------------------------------------------
-- Consistency triggers - same shape as assert_company_matches_vendor()/
-- assert_company_matches_contact() (migrations 2 and 20): without these, a
-- caller who can write to company A's service-role-bypassed insert could
-- attach a checklist item, package, or document link across a company/
-- vendor/upload-request boundary that the FKs alone would not catch, since
-- each FK only proves the referenced row exists - not that it belongs to
-- the same tenant as the other columns on this row.
-- ---------------------------------------------------------------------------

create or replace function public.assert_company_matches_upload_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  req_company uuid;
  req_vendor  uuid;
begin
  select company_id, vendor_id into req_company, req_vendor
    from public.vendor_upload_requests where id = new.upload_request_id;

  if req_company is null then
    raise exception 'upload_request_id % does not exist', new.upload_request_id using errcode = '23503';
  end if;

  if req_company <> new.company_id or req_vendor <> new.vendor_id then
    raise exception 'company_id/vendor_id do not match upload request %', new.upload_request_id
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_upload_request() from public, anon, authenticated;

create trigger upload_request_checklist_items_matches_request
  before insert or update on public.upload_request_checklist_items
  for each row execute function public.assert_company_matches_upload_request();

create trigger submission_packages_matches_request
  before insert or update on public.submission_packages
  for each row execute function public.assert_company_matches_upload_request();

create or replace function public.assert_company_matches_package()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  pkg_company uuid;
  pkg_vendor  uuid;
  doc_company uuid;
  doc_vendor  uuid;
begin
  select company_id, vendor_id into pkg_company, pkg_vendor
    from public.submission_packages where id = new.package_id;

  if pkg_company is null then
    raise exception 'package_id % does not exist', new.package_id using errcode = '23503';
  end if;

  if pkg_company <> new.company_id or pkg_vendor <> new.vendor_id then
    raise exception 'company_id/vendor_id do not match submission package %', new.package_id
      using errcode = '23514';
  end if;

  select company_id, vendor_id into doc_company, doc_vendor
    from public.vendor_documents where id = new.document_id;

  if doc_company is null then
    raise exception 'document_id % does not exist', new.document_id using errcode = '23503';
  end if;

  if doc_company <> new.company_id or doc_vendor <> new.vendor_id then
    raise exception 'company_id/vendor_id do not match document %', new.document_id
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.assert_company_matches_package() from public, anon, authenticated;

create trigger package_documents_matches_package
  before insert or update on public.package_documents
  for each row execute function public.assert_company_matches_package();

-- ---------------------------------------------------------------------------
-- Replacement lineage on vendor_documents - see this migration's own
-- docblock for why this is a distinct column from duplicate_of_document_id.
-- ---------------------------------------------------------------------------

alter table public.vendor_documents
  add column replaces_document_id uuid references public.vendor_documents (id) on delete set null;

comment on column public.vendor_documents.replaces_document_id is
  'Set by replaceDeficientDocument() (src/workflows/submissionPackages.ts, Task 8a) when this document was uploaded to correct a specific deficient predecessor within an already-finalized submission package. Distinct from duplicate_of_document_id (migration 12/document_extraction), which means "identical file bytes, same sha256, re-uploaded elsewhere" - a replacement is expected to have DIFFERENT bytes (the corrected file) and will essentially never share a sha256 with what it replaces, so duplicate_of_document_id cannot correctly describe this relationship.';

create index vendor_documents_replaces_idx on public.vendor_documents (replaces_document_id)
  where replaces_document_id is not null;

-- ---------------------------------------------------------------------------
-- Row level security - same uniform can_write_company()/current_company_ids()
-- shape as every other company-scoped table. No delete policy on any of
-- these three tables, matching vendor_upload_requests/vendor_documents: a
-- checklist item, a package, or a package-document link is part of the
-- compliance record once it exists, not something to quietly remove.
-- Writes from the anonymous vendor-portal side (createPackage(),
-- addPackageDocument(), finalizePackage(), replaceDeficientDocument()) all
-- go through the service-role client after manual token validation, exactly
-- like uploadDocumentForToken() - RLS here protects the data from other
-- *tenants*, it does not (and cannot) gate the anonymous portal itself.
-- ---------------------------------------------------------------------------

alter table public.upload_request_checklist_items enable row level security;
alter table public.submission_packages             enable row level security;
alter table public.package_documents                enable row level security;

create policy upload_request_checklist_items_select on public.upload_request_checklist_items
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy upload_request_checklist_items_insert on public.upload_request_checklist_items
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy upload_request_checklist_items_update on public.upload_request_checklist_items
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy submission_packages_select on public.submission_packages
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy submission_packages_insert on public.submission_packages
  for insert to authenticated
  with check (public.can_write_company(company_id));

create policy submission_packages_update on public.submission_packages
  for update to authenticated
  using (public.can_write_company(company_id))
  with check (public.can_write_company(company_id));

create policy package_documents_select on public.package_documents
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

create policy package_documents_insert on public.package_documents
  for insert to authenticated
  with check (public.can_write_company(company_id));
