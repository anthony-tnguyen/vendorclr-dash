-- Task 8a follow-up - covering indexes for foreign keys the initial two
-- submission-packages migrations left unindexed, flagged by get_advisors
-- (performance / unindexed_foreign_keys) immediately after applying them
-- live against fzrcowwonezflydicpbd.

create index package_documents_vendor_idx
  on public.package_documents (vendor_id);

create index upload_request_checklist_items_vendor_idx
  on public.upload_request_checklist_items (vendor_id);

create index submission_packages_previous_package_idx
  on public.submission_packages (previous_package_id)
  where previous_package_id is not null;

create index document_processing_jobs_vendor_idx
  on public.document_processing_jobs (vendor_id);
