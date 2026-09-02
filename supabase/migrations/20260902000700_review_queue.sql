-- Phase 3 continued / migration 12 - give the review queue a real screen.
--
-- Two known compromises from the README, both closed here:
--
--   "compliance_queue_items has no document_id column. reprocessDocument()
--   updates the vendor's most recently created queue item as an
--   approximation, not the exact one a given document produced."
--
--   "A review-queue UI. needs_review documents only show up as
--   compliance_queue_items rows in 'in-review' state - there is no screen
--   yet for looking at parsed_data, review_reason, or approving/rejecting a
--   match by hand."
--
-- document_id makes the link exact rather than approximated. resolution/
-- resolution_note/resolved_at give the review screen a real outcome to
-- record and a way to remove a handled item from the active queue -
-- 'resolved' is a new terminal state alongside the existing three; nothing
-- before this migration ever set it, so every existing row is unaffected.

alter table public.compliance_queue_items
  add column document_id uuid references public.vendor_documents (id) on delete set null,
  add column resolution text check (resolution in ('approved', 'rejected')),
  add column resolution_note text not null default '',
  add column resolved_at timestamptz;

alter table public.compliance_queue_items
  drop constraint compliance_queue_items_state_check;

alter table public.compliance_queue_items
  add constraint compliance_queue_items_state_check
  check (state in ('queued', 'in-review', 'escalated', 'resolved'));

-- A resolved item always carries a resolution and vice versa - the two
-- columns describe one fact ("was this handled, and how"), and letting them
-- disagree (resolved with no resolution, or a resolution on a still-open
-- item) would be a data-entry bug no application check would catch later.
alter table public.compliance_queue_items
  add constraint compliance_queue_items_resolution_matches_state
  check (
    (state = 'resolved' and resolution is not null)
    or (state != 'resolved' and resolution is null)
  );

create index compliance_queue_items_document_idx on public.compliance_queue_items (document_id);

-- Backfill: best-effort match to the vendor_documents row nearest in time,
-- for any environment that already has queue items predating this column
-- (the linked live project does not - confirmed empty - but a migration
-- should be correct for whatever data exists, not just today's). A queue
-- item created by uploadDocumentForToken() (the only source of rows, going
-- forward this migration is applied) is inserted in the same request as its
-- document, so "nearest in created_at, same vendor" is exact in every real
-- case; only a row somehow lacking any document for its vendor is left null.
update public.compliance_queue_items cqi
set document_id = (
  select vd.id
  from public.vendor_documents vd
  where vd.vendor_id = cqi.vendor_id
  order by abs(extract(epoch from (vd.created_at - cqi.created_at)))
  limit 1
)
where cqi.document_id is null
  and exists (select 1 from public.vendor_documents vd where vd.vendor_id = cqi.vendor_id);
