-- Phase 4 / migration 14 - a real audit log.
--
-- Every prior phase either superseded a row (vendor_policies - a renewal
-- keeps the old row with status='superseded' rather than overwriting it) or
-- left an implicit trail in a workflow-specific table (email_outbox,
-- policy_reminder_log). Neither answers "which staff member approved this,
-- and when" for the two actions that most need it: a human review decision
-- (resolveReviewItem) and a manual retry (reprocessDocument) - both run on
-- the service role after assertPlatformAdmin(), so there was previously no
-- record of WHO acted at all, only what happened and when.
--
-- Deliberately scoped to the three server-function write paths that
-- currently have no actor trail of their own, not every mutation in this
-- schema - vendor_policies/vendor_compliance_items changes already have
-- their own history (superseding, review_reason, applied_policy_id); this
-- does not duplicate that. Widen the action/target_type CHECK constraints
-- as more actions need this, rather than trying to cover everything in one
-- pass - see Known compromises in supabase/README.md.

-- Lets a caller on the request-scoped client (createUploadRequest(), a
-- genuine company member) record their own auth.uid() without a second
-- round trip, and lets a service-role caller (resolveReviewItem(),
-- reprocessDocument() - both already staff-only via assertPlatformAdmin())
-- fetch the id to pass explicitly, since the service role has no bound
-- session of its own for auth.uid() to resolve. Mirrors
-- current_company_ids()'s existing naming and shape exactly.
create or replace function public.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid();
$fn$;

revoke execute on function public.current_user_id() from public, anon;
grant execute on function public.current_user_id() to authenticated;

create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  -- Null rather than blocked by FK-on-delete: a departed user's past
  -- actions are still part of the record. Nothing in this app deletes an
  -- auth.users row today, but the column should not assume that never
  -- changes.
  actor_id    uuid references auth.users (id) on delete set null,
  action      text not null check (action in (
                'upload_request_created', 'review_resolved', 'document_reprocessed'
              )),
  target_type text not null check (target_type in ('vendor', 'vendor_document', 'compliance_queue_item')),
  target_id   uuid not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_log_company_idx on public.audit_log (company_id, created_at desc);
create index audit_log_target_idx on public.audit_log (target_type, target_id);

-- A plain column default of `auth.uid()` cannot do this: authenticated has
-- no USAGE on schema auth in this project (confirmed by the same
-- "permission denied for schema auth" the harness reproduces for a bare
-- auth.uid() reference outside a security definer boundary) - every other
-- direct auth.uid() read in this schema already goes through one
-- (current_company_ids(), is_platform_admin(), current_user_id() above).
-- A BEFORE INSERT trigger gets the same "omit actor_id and it just works"
-- ergonomics for createUploadRequest() (the request-scoped-client writer)
-- while staying inside that boundary, and leaves an explicitly-passed
-- actor_id (resolveReviewItem()/reprocessDocument(), on the service role)
-- untouched.
create or replace function public.set_audit_log_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.actor_id is null then
    new.actor_id := auth.uid();
  end if;
  return new;
end;
$fn$;

revoke execute on function public.set_audit_log_actor() from public, anon, authenticated;

create trigger audit_log_set_actor
  before insert on public.audit_log
  for each row execute function public.set_audit_log_actor();

alter table public.audit_log enable row level security;

-- Read-only for company members/staff - an audit trail is not something
-- anyone edits, matching policy_reminder_log's shape.
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (company_id in (select public.current_company_ids()) or public.is_platform_admin());

-- Covers both actor shapes this table records: createUploadRequest() writes
-- as a genuine company member (can_write_company) with actor_id left to its
-- auth.uid() default; resolveReviewItem()/reprocessDocument() write as
-- staff on the service role, which bypasses RLS entirely - is_platform_admin()
-- here is defense in depth, not the primary gate, the same relationship
-- service-role writes have to RLS everywhere else in this schema.
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (public.can_write_company(company_id) or public.is_platform_admin());

-- No update or delete policy anywhere, for anyone: an audit row is
-- immutable once written, the same reasoning vendor_upload_requests/
-- vendor_documents already apply ("part of the compliance record, not
-- something to quietly remove").
