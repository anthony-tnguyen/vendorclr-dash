-- Task 9a follow-up: the get_advisors performance lint flagged both new FKs
-- from this dispatch's own migration (20260917000900_versioned_extractions.sql)
-- as unindexed - document_extractions.reviewer_id and
-- vendor_documents.current_extraction_id. Matches the same
-- "*_fk_indexes" pattern this project already established
-- (20260917000500_submission_packages_fk_indexes.sql) for exactly this
-- situation: add the covering index once the advisor confirms it's needed,
-- rather than guessing ahead of real usage data.

create index document_extractions_reviewer_id_idx on public.document_extractions (reviewer_id)
  where reviewer_id is not null;

create index vendor_documents_current_extraction_id_idx on public.vendor_documents (current_extraction_id)
  where current_extraction_id is not null;
