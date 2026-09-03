-- Phase 4 / migration 17 - an automated (not just manually-invoked) retry
-- queue for failed extraction.
--
-- reprocessDocument() (vendorUploadRequests.ts) has been the only way to
-- retry a 'failed' document since Phase 2 - an admin has to notice and
-- click a button. documents_due_for_retry is what a scheduled job reads
-- instead; the actual retry runs in a Deno Edge Function
-- (supabase/functions/retry-failed-documents), scheduled by pg_cron via
-- pg_net in 20260903000400_schedule_automated_retries.sql once the function
-- is deployed and its URL is known - same split as
-- 20260902000500_renewal_reminders.sql/20260902000600_schedule_renewal_reminders.sql,
-- same reason: pg_cron/pg_net need a real background worker and real
-- networking PGlite cannot provide.
--
-- retry_count/next_retry_at are written ONLY by the automated path, never by
-- reprocessDocument(): they track "how many automated attempts has this
-- document used," a distinct budget from a human's own patience manually
-- retrying. A human reprocessing a document already at the automated cap
-- does not consume or reset that cap - and does not need to, since a
-- reprocess that succeeds leaves 'failed' entirely (naturally exiting the
-- retry pool) and one that doesn't leaves retry_count exactly where
-- automated retry left it.
--
-- Bounded at 5 attempts with widening backoff (1h, 4h, 12h, 24h, 48h - see
-- the Edge Function) rather than retried forever: a document that still
-- fails after 5 automated attempts most likely has a real, non-transient
-- problem (an unreadable file, a persistent API issue) an automated retry
-- cannot fix by trying again - it needs a person, via reprocessDocument()
-- or a fresh upload, not more of the same call.
--
-- A successful automated retry never writes processing_status = 'processed'
-- - only reads it back that way if a human later approves via the review
-- screen. 'processed' means more here than "confidently extracted": in
-- applyExtractionResult() (the original upload path), it means confidently
-- extracted AND cleanly applied to vendor_policies by
-- applyComplianceEngine(). The Edge Function deliberately does not port
-- that matching/writing logic to Deno (a much bigger duplication than this
-- migration's small, pure-function ports) - so any successful automated
-- re-extraction lands as 'needs_review' regardless of confidence, the same
-- outcome a human-reviewable document already gets, and a person applies it
-- (or not) through the review screen exactly as they would any other
-- needs_review document.
--
-- Also excludes a document whose linked compliance_queue_items row is
-- already 'resolved': if a human already looked at this document and chose
-- reject (not_configured/failed extraction). None of these are true when
-- rejecting, resolveReviewItem() leaves vendor_documents.processing_status
-- untouched, so a 'failed' document with an already-rejected queue item is
-- possible - retrying it automatically forever after a human explicitly
-- declined to act on it would be wasted work, not a service.

alter table public.vendor_documents
  add column retry_count int not null default 0 check (retry_count >= 0),
  add column next_retry_at timestamptz;

create view public.documents_due_for_retry
with (security_invoker = true) as
select
  vd.id as document_id,
  vd.company_id,
  vd.vendor_id,
  vd.storage_path,
  vd.mime_type,
  vd.file_name,
  vd.retry_count
from public.vendor_documents vd
where vd.processing_status = 'failed'
  and vd.retry_count < 5
  and (vd.next_retry_at is null or vd.next_retry_at <= now())
  and not exists (
    select 1 from public.compliance_queue_items cqi
    where cqi.document_id = vd.id and cqi.state = 'resolved'
  );
