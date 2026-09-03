-- Phase 4 / migration 15 - let an admin cancel an outstanding upload request.
--
-- vendor_upload_requests.status has had 'cancelled' in its CHECK constraint
-- since migration 4 (Phase 1), and vendor_upload_requests_open_idx has
-- excluded it from "still open" queries just as long - the schema was built
-- expecting this, but nothing ever set it. cancelUploadRequest()
-- (vendorUploadRequests.ts) is that missing write. No new table, no new
-- RLS policy: vendor_upload_requests_update already grants
-- can_write_company() the UPDATE this needs.
--
-- Widens audit_log's action/target_type CHECK constraints (migration 14)
-- to record who cancelled which request - target_type is
-- 'vendor_upload_request' here, not 'vendor', since the request itself
-- (not the vendor record) is what changed.

alter table public.audit_log
  drop constraint audit_log_action_check;

alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed'
  ));

alter table public.audit_log
  drop constraint audit_log_target_type_check;

alter table public.audit_log
  add constraint audit_log_target_type_check
  check (target_type in ('vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item'));
