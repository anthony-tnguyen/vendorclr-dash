-- Task 3 (Engineer A) - the DB-backed atomic counters behind
-- assertUploadAllowed() (src/workflows/uploadAbuse.server.ts). This project
-- is 100% Supabase/Postgres, with no Redis/KV/other store, so "atomic rate
-- limiting" here means exactly one thing: a table keyed by
-- (bucket_key, window_start), incremented through a single
-- `insert ... on conflict do update set count = count + 1 returning count`
-- statement. That single round trip is safe under concurrent callers on its
-- own - Postgres takes a row lock on the conflicting unique key for the
-- duration of the UPDATE, so two callers hitting the same bucket/window at
-- the same instant are serialized by Postgres itself, not by any
-- application-level lock this project would otherwise have to invent.
--
-- bucket_key packs both "which limit" and "which identity" into one string
-- (e.g. "resolve:ip:<hmac>", "upload:token:<sha256>",
-- "upload:company:<uuid>") - see uploadAbuse.server.ts for the exact values.
-- The IP-identified buckets never store a raw IP address: the caller HMACs
-- it first (UPLOAD_ABUSE_IP_HMAC_SECRET, server-only) before it ever reaches
-- this table, so a dump of this table cannot be reversed into anyone's real
-- IP, the same "store only the digest" posture vendor_upload_requests
-- already takes with token_hash.
--
-- window_start is a fixed-window boundary, not a sliding one: application
-- code truncates "now" to a multiple of that limit's own window length
-- (milliseconds since epoch), so every caller within the same window
-- computes the identical window_start and therefore collides on the same
-- row - that collision is the whole mechanism. A fixed window is simpler
-- than a sliding one and is the standard, well-understood tradeoff (a
-- caller can in principle get slightly more than the nominal rate right at
-- a window boundary) - acceptable here since these are abuse-resistance
-- limits, not a precise billing meter.

create table public.upload_rate_limit_counters (
  bucket_key   text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket_key, window_start)
);

comment on table public.upload_rate_limit_counters is
  'Atomic per-bucket, per-fixed-window counters backing assertUploadAllowed() (src/workflows/uploadAbuse.server.ts) - this project''s only DB-backed rate limiter. Never queried or written directly by application code - only through increment_upload_rate_limit_counter() below, whose single atomic UPSERT is what makes concurrent callers safe. Rows are not actively pruned by this migration (no pg_cron job scheduled here - out of scope for this task); a stale row is inert dead weight, not a correctness problem, since a bucket is only ever consulted for the exact window_start "now" currently falls into.';

-- No RLS policy is defined on purpose - this table has no company_id/user_id
-- to scope by (bucket_key already encodes the HMAC-digested identity being
-- limited, not a real foreign key to anything), so "enabled, zero policies"
-- denies every direct read/write to anon/authenticated, the same shape as
-- vendor_upload_requests before the service-role path was carved out for
-- it. The only caller that ever reaches this table is service_role, via
-- increment_upload_rate_limit_counter() below, which service_role can use
-- regardless of RLS because service_role bypasses RLS outright (see
-- harness.ts's BOOTSTRAP: `create role service_role nologin bypassrls`).
alter table public.upload_rate_limit_counters enable row level security;

-- ---------------------------------------------------------------------------
-- increment_upload_rate_limit_counter(): the one atomic check-and-increment
-- primitive. Not SECURITY DEFINER - service_role already bypasses RLS on
-- its own, so there is no elevated-owner behavior this function needs that
-- the caller's own role doesn't already have (same reasoning
-- get_database_size_bytes() gives for not being SECURITY DEFINER either).
-- Locked to service_role only via the same revoke-from-named-roles pattern
-- migration 5 established everywhere else in this schema (see the
-- "Supabase `revoke ... from public` gotcha": PUBLIC and the
-- anon/authenticated roles are separate grants; only an explicit
-- `revoke ... from anon, authenticated` removes the default-privileges
-- EXECUTE grant Supabase applies at function-creation time).
-- ---------------------------------------------------------------------------

create or replace function public.increment_upload_rate_limit_counter(
  p_bucket_key text,
  p_window_start timestamptz
)
returns integer
language sql
set search_path = public, pg_temp
as $fn$
  insert into public.upload_rate_limit_counters (bucket_key, window_start, count)
  values (p_bucket_key, p_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set count = public.upload_rate_limit_counters.count + 1
  returning count;
$fn$;

revoke execute on function public.increment_upload_rate_limit_counter(text, timestamptz) from public, anon, authenticated;
grant execute on function public.increment_upload_rate_limit_counter(text, timestamptz) to service_role;
