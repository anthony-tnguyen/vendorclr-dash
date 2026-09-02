-- Phase 2 / migration 7 - document intelligence: the extraction result columns
-- on vendor_documents, and duplicate-upload tracking.
--
-- Deliberately does NOT add a document_type/policy_type enum change, a
-- document_processing_jobs table, or anything that writes to
-- vendor_policies / vendor_compliance_items. Extraction produces a structured,
-- confidence-scored JSON result and stores it - nothing more. Turning that
-- result into an actual policy update or compliance decision is Phase 3 (the
-- compliance engine): a received, successfully-parsed document is still not
-- itself evidence of compliance, same principle as Phase 1's upload path.
--
-- No document_processing_jobs table: extraction currently runs synchronously,
-- inline in uploadDocumentForToken() (see src/workflows/vendorUploadRequests.ts)
-- and reprocessDocument(). There is exactly one attempt per upload with no
-- retry queue, so a separate jobs table would track nothing a single row on
-- vendor_documents doesn't already capture. Revisit once processing becomes
-- genuinely async (Phase 4).

alter table public.vendor_documents
  add column parsed_data jsonb,
  add column extraction_confidence numeric check (
    extraction_confidence is null or extraction_confidence between 0 and 1
  ),
  -- Points at an earlier document for the same vendor with identical
  -- sha256. Set opportunistically when found; duplicates are still stored and
  -- still get their own extraction attempt unless the original was already
  -- successfully processed (see uploadDocumentForToken), not silently merged.
  add column duplicate_of_document_id uuid references public.vendor_documents (id) on delete set null;

comment on column public.vendor_documents.parsed_data is
  'Structured extraction result validated against InsuranceExtractionSchema (src/workflows/insuranceExtractionSchema.ts). Null until processing_status reaches processed or needs_review.';

comment on column public.vendor_documents.extraction_confidence is
  'Overall 0-1 confidence from the extraction model, mirrored from parsed_data.overall_confidence for cheap SQL filtering (e.g. flagging low-confidence documents) without unpacking the JSON.';
