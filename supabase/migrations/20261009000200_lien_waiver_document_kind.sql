-- Add 'lien_waiver' to the document-kind vocabulary.
--
-- A lien waiver is now a configurable required document (REQUIREMENT_CATALOG's
-- document_lien_waiver rule, surfaced in company Settings, requirement profiles
-- and the new per-vendor requirement panel). For the evaluator
-- (evaluatePackage.ts's evaluateDocument()) to ever see one satisfied, a vendor
-- must be able to upload a document under this kind, which the two
-- document_kind CHECK constraints currently forbid.
--
-- These checks were created inline and unnamed (migration 20260917000300), so
-- Postgres named them <table>_document_kind_check. Drop and re-add each with the
-- widened vocabulary. 'lien_waiver' is NOT added to any default checklist here -
-- it only blocks a submission when a company requires it, exactly like the
-- endorsement kinds.

alter table public.upload_request_checklist_items
  drop constraint if exists upload_request_checklist_items_document_kind_check;

alter table public.upload_request_checklist_items
  add constraint upload_request_checklist_items_document_kind_check
  check (document_kind in (
    'certificate_of_insurance',
    'additional_insured_endorsement',
    'waiver_of_subrogation_endorsement',
    'primary_noncontributory_endorsement',
    'lien_waiver',
    'other'
  ));

alter table public.package_documents
  drop constraint if exists package_documents_document_kind_check;

alter table public.package_documents
  add constraint package_documents_document_kind_check
  check (document_kind in (
    'certificate_of_insurance',
    'additional_insured_endorsement',
    'waiver_of_subrogation_endorsement',
    'primary_noncontributory_endorsement',
    'lien_waiver',
    'other'
  ));
