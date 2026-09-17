# Incident response

Status: Task 12 (data lifecycle - Engineer A slice).

A runbook for a security or data incident (a suspected breach, an RLS/
authorization bug that leaked data across tenants, a leaked credential, a
malicious upload, or similar). This reuses the operational infrastructure
already in this codebase rather than inventing a parallel incident-tracking
system - see each section below for exactly which existing piece it points
to.

## Detection

Signals that should prompt starting this runbook, in order of how this
codebase would actually surface them:

- **`logOperational()` / `OperationalLog` entries** (`src/lib/observability/
logger.server.ts`) - every server function, Edge Function, and cron job
  logs one structured envelope per call with `level`, `event`, `outcome`,
  and (redacted) `extra` context. A sustained run of `outcome: "failure"`
  for a security-relevant `event` (e.g. repeated `resolveUploadToken`
  failures, a spike in `assertUploadAllowed` throttle events from
  `src/workflows/uploadAbuse.server.ts`) is a detection signal, not just an
  operational one.
- **Sentry** (`src/lib/observability/sentry.server.ts` / `sentryClient.ts`)
  - captures errors with stack traces separately from the structured log
    (see `logger.server.ts`'s own docblock on why the two are separate). An
    error-rate spike or a specific exception pattern (e.g. many failed
    `can_write_company()`-denied writes) is a detection signal.
- **`GET /api/health/ready`** (`src/routes/api.health.ready.ts`) - reports
  `dependencies.supabase` as `"unreachable"` and returns HTTP 503 if the
  service-role client can't reach the database. Not itself a security
  signal, but the first thing to check if an incident coincides with
  reachability - rules out "is this actually an outage, not a breach."
- **The Operations page** (`src/features/admin/OperationsPage.tsx`,
  `src/workflows/operations.ts`) - the existing admin-facing surface for
  `getOperationalFailures()` and alerting (`notifyAlert()`, which POSTs to
  `VITE_ALERT_WEBHOOK_URL` when configured - see `.env.example`). Check
  here for anything already flagged before assuming this is undetected.
- **A report from a customer or a member of the public** - the most common
  real-world detection path for a data-exposure incident, and the one none
  of the above catches by construction.

## Containment

Specific to what this codebase can actually do, in likely order of use:

1. **Revoke a specific credential.** Rotate the leaked secret
   (`VENDORCLEAR_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`,
   `VIRUSTOTAL_API_KEY`, `UPLOAD_ABUSE_IP_HMAC_SECRET`, `TURNSTILE_SECRET_KEY`
   - see `.env.example` for the full list and what each guards) at its
     provider and redeploy with the new value. A service-role key leak is
     the most severe of these - it bypasses RLS entirely (see
     `serverClient.server.ts`'s own docblock).
2. **Suspend a specific upload token or upload request.** A compromised
   vendor magic link can be invalidated by setting its
   `vendor_upload_requests.status` to `'cancelled'` (the same transition
   "Cancelling an upload request" in `supabase/README.md` already
   documents) - it does not require code changes to contain.
3. **Suspend a specific company member's access.** Deleting or
   role-downgrading a `company_members` row revokes that person's access
   immediately (every table's RLS policy re-checks `current_company_ids()`/
   `can_write_company()` on every request - there is no cached
   authorization to also invalidate).
4. **Application rollback**, if the incident stems from a bad deploy (an
   RLS regression, an accidentally-permissive policy) - see
   `docs/operations/rollback.md`, which is the existing, tested procedure
   for this; do not improvise a different rollback path during an
   incident.
5. **Do NOT reach for `delete-company.ts` as a containment tool.** Deleting
   a company's data destroys the evidence needed for the post-mortem below
   and does not undo an exposure that already happened. If deletion is
   ultimately warranted as part of the response, it follows the normal
   `customer-deletion.md` approval workflow, after containment and
   investigation, not as a first reaction.

## Notification

<!-- PENDING LEGAL/PRODUCT APPROVAL -->

**This project has no approved breach-notification policy** - who must be
told, on what timeline, and in what form is a legal determination this
session cannot make (same constraint as `data-retention.md` and
`account-termination.md`). Do not draft or send a customer-facing breach
notification without counsel/product-owner review of both the content and
the timing. What this runbook can state as fact, not commitment:
`audit_log` and the structured `logOperational()` history are the factual
record this codebase can produce to inform what actually happened and who
was affected. Assembling that record is an engineering task; deciding who
gets told what is not.

## Post-mortem

1. Use `audit_log` (queryable by `company_id`, `actor_id`, `action`,
   `target_type`/`target_id`, `created_at` - see
   `supabase/migrations/20260902000900_audit_log.sql`) and the structured
   `OperationalLog` history to reconstruct a timeline: what happened, when,
   to which company/rows, and who/what triggered it.
2. If a company's data needs to be exported for the investigation record
   itself (not for the customer), `scripts/export-company.ts` produces
   exactly that - see `customer-export.md`.
3. Write up: detection time, containment time, root cause, blast radius
   (which companies/rows/documents were actually affected - not assumed),
   and the specific fix (a code change, an RLS policy correction via
   `docs/operations/rollback.md`'s forward-only migration path, a rotated
   credential).
4. If the root cause was a schema/RLS gap, the fix ships as a forward
   migration with `bun run db:verify` passing (the RLS/tenancy regression
   suite) - never a hotfix applied by hand against production, for the same
   reasons `rollback.md` gives for never hand-running SQL outside the
   migration history.
