-- Phase 3 continued / migration 9 - vendor and admin notification emails.
--
-- Two new email_outbox templates, sent from applyExtractionResult() (see
-- src/workflows/vendorUploadRequests.ts) once a document's final
-- processing_status is known:
--
--   document_received  -> the vendor, outcome-dependent copy that never
--                          repeats the specific matching-engine reason back
--                          to them (see the docblock on documentOutcomeCopy()
--                          in emailTemplates.ts for why).
--   admin_review_needed -> the company's owner(s), carrying the specific
--                          reason (vendor_documents.review_reason or
--                          processing_error) - the person reading this one is
--                          the one who has to act on it.
--
-- No new tables: email_outbox already has everything these need
-- (company_id, vendor_id, to_email, status, error). Only the template CHECK
-- constraint needs to widen.

alter table public.email_outbox
  drop constraint email_outbox_template_check;

alter table public.email_outbox
  add constraint email_outbox_template_check
  check (template in ('vendor_onboarding', 'renewal_request', 'document_received', 'admin_review_needed'));
