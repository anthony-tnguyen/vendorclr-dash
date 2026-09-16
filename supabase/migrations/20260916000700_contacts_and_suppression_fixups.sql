-- Follow-up to 20260916000600_contacts_and_suppression.sql, applied after
-- get_advisors flagged two things on the live project:
--
--   1. normalize_suppressed_recipient_email() had no `set search_path` -
--      every other function in this schema pins one (public, pg_temp) to
--      close the mutable-search-path lint class; this one was missed.
--   2. suppressed_recipients.source_event_id has no covering index for its
--      FK, the same class of finding get_advisors already flags on several
--      pre-existing tables (company_invitations, vendor_documents, ...).
--
-- Same pattern as 20260916160903_construction_core_security_fix.sql and
-- 20260916061515_fix_get_database_size_bytes_search_path.sql - a small,
-- separately-named fixup migration rather than silently editing the
-- migration that already shipped.

create or replace function public.normalize_suppressed_recipient_email()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$fn$;

create index suppressed_recipients_source_event_idx
  on public.suppressed_recipients (source_event_id);
