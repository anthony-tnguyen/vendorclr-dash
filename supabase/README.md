# Backend: auth, tenancy, the vendor/policy model, and the renewal loop

## Anonymous vendor submission packages

`/vendor-upload/:token` is an account-free, token-authorized submission-package
flow. The server validates the token before service-role access, stores
validated documents privately, and queues extraction only after package
finalization. A receipt confirms receipt and queued processing, never
compliance. Open-package attachments may be detached before finalization;
deficient replacements preserve prior evidence through
`vendor_documents.replaces_document_id`.

Cloudflare Turnstile is optional and not configured in this repository. When
configured, use both `TURNSTILE_SECRET_KEY` server-side and the matching
`VITE_TURNSTILE_SITE_KEY` client-side; existing rate limits remain enforced.

Four phases so far:

- **Phase 0** — auth, tenancy, and a real vendor/policy model. Before this, the app
  had no users, no accounts, and no link between a vendor and whoever owns it.
- **Phase 1** — the outbound half of the renewal workflow: an admin requests an
  updated certificate, the vendor gets a magic link with no account required,
  uploads a file, and it lands in private storage and the existing admin
  Compliance Queue screen.
- **Phase 2** — document intelligence: the uploaded file is read into
  structured, confidence-scored JSON and stored alongside it. Still does not
  touch `vendor_policies` or `vendor_compliance_items` — see
  [Document intelligence (Phase 2)](#document-intelligence-phase-2).
- **Phase 3** — the compliance engine: a deterministic (never LLM-confidence-
  gated) rule decides whether an extraction is safe to apply automatically,
  updates `vendor_policies` when it is, recomputes the compliance rail, and
  emails the vendor and the company's owner(s) with the outcome.
  See [The compliance engine (Phase 3)](#the-compliance-engine-phase-3).

## What the migrations create

| Migration                                                 | Contents                                                                                                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260901000100_identity_and_tenancy.sql`                 | `profiles`, `companies`, `company_members`, `platform_admins`, the RLS helper functions, signup provisioning                                                                                        |
| `20260901000200_vendor_domain.sql`                        | `vendors`, `vendor_policies`, `vendor_compliance_items`, `vendor_coverage_limits` (dropped in migration 13)                                                                                         |
| `20260901000300_tasks_queue_leads_and_views.sql`          | `tasks`, `compliance_queue_items`, `leads`, and the report/admin views                                                                                                                              |
| `20260901000400_vendor_upload_requests_and_documents.sql` | `vendor_upload_requests`, `vendor_documents`, `email_outbox`, the private `vendor-documents` storage bucket                                                                                         |
| `20260902000100_security_and_performance_hardening.sql`   | Fixes discovered by applying 1-4 to a real project and running Supabase's advisor — see [Security model](#security-model)                                                                           |
| `20260902000200_document_extraction.sql`                  | Adds `parsed_data`, `extraction_confidence`, `duplicate_of_document_id` to `vendor_documents`                                                                                                       |
| `20260902000300_compliance_engine.sql`                    | `vendor_documents.applied_policy_id`/`review_reason`, and `apply_policy_renewal()`                                                                                                                  |
| `20260902000400_notification_emails.sql`                  | Widens `email_outbox.template` to add `document_received`, `admin_review_needed`                                                                                                                    |
| `20260902000500_renewal_reminders.sql`                    | `policy_reminder_log`, `current_reminder_threshold()`, `policies_due_for_reminder`; widens `email_outbox.template` to add `renewal_reminder`                                                        |
| `20260902000600_schedule_renewal_reminders.sql`           | Enables `pg_cron`/`pg_net`, schedules a daily call into the `send-renewal-reminders` Edge Function — see [Renewal reminders](#renewal-reminders)                                                    |
| `20260902000700_review_queue.sql`                         | Adds `document_id`, `resolution`, `resolution_note`, `resolved_at`, and a `'resolved'` state to `compliance_queue_items` — see [The review queue screen](#the-review-queue-screen)                  |
| `20260902000800_compliance_requirements.sql`              | Drops `vendor_coverage_limits`; adds `compliance_requirements` — see [Matching against coverage requirements](#matching-against-coverage-requirements)                                              |
| `20260902000900_audit_log.sql`                            | Adds `audit_log`, `current_user_id()` — see [Audit log](#audit-log)                                                                                                                                 |
| `20260903000100_upload_request_cancellation.sql`          | Widens `audit_log`'s `action`/`target_type` CHECK constraints for `upload_request_cancelled` — see [Cancelling an upload request](#cancelling-an-upload-request)                                    |
| `20260903000200_malware_scanning.sql`                     | Adds `malware_scan_status`/`malware_scan_detail`/`scanned_at` to `vendor_documents` — see [Malware scanning](#malware-scanning)                                                                     |
| `20260903000300_automated_retry_queue.sql`                | Adds `vendor_documents.retry_count`/`next_retry_at`, `documents_due_for_retry` — see [Automated retry queue](#automated-retry-queue)                                                                |
| `20260903000400_schedule_automated_retries.sql`           | Schedules an hourly call into the `retry-failed-documents` Edge Function via `pg_cron`/`pg_net` — see [Automated retry queue](#automated-retry-queue)                                               |
| `20260903000500_email_bounce_handling.sql`                | Widens `email_outbox.status`; adds `email_delivery_events` — see [Email bounce handling](#email-bounce-handling)                                                                                    |
| `20260903000600_certificate_holder_on_file.sql`           | Adds `vendor_policies.certificate_holder_name`/`certificate_holder_address`; widens `apply_policy_renewal()` to two more parameters — see [Certificate holder on file](#certificate-holder-on-file) |
| `20260915000100_gated_signup_invites.sql`                 | `signup_invites`, `create_signup_invite()`; gates self-serve business signup behind an admin-issued invite code                                                                                     |
| `20260916000100_company_feature_flags.sql`                | `company_feature_flags`, `set_company_feature_flag()` — see [Feature flags](#feature-flags)                                                                                                         |

The headline modelling change: **a vendor no longer owns one flat policy.**
`Vendor.policyNumber` / `Vendor.expiresOn` in `src/data/contracts.ts` could hold
exactly one carrier and one date. A real sub carries GL + WC + Auto + Umbrella with
different carriers and expirations, so policies are their own rows now. The
repository still projects a primary policy onto those two legacy fields, so the
existing UI renders unchanged.

## Running it

```bash
supabase start
```

Then sign up through the app (which creates the `auth.users` row), and seed:

```bash
supabase db reset
```

`seed.sql` attaches demo data to the first user in `auth.users`, so sign up first.
Point the app at the local stack by copying `.env.example` to `.env` and filling in
the values `supabase start` printed.

With both variables **unset** the app runs entirely on the in-memory demo
repository — no database, no secrets, no network. That is how the Vitest suite and
the Lovable preview run, and it is why every change here is additive.

For the Phase 1 vendor portal you additionally need `SUPABASE_SERVICE_ROLE_KEY`
(server-only, no `VITE_` prefix — `supabase start` prints it). Optionally
`RESEND_API_KEY` to send real email; without it, "Request documents" on the
vendor detail page still creates the request and returns the magic link
directly to the admin to copy and share.
For Phase 2, optionally `ANTHROPIC_API_KEY`; without it a document is still
stored but not extracted (`processing_status` ends up `'failed'`, with
`processing_error` saying so) until `reprocessDocument()` is called after the
key is set. See `.env.example`.

## The renewal loop (Phase 1)

```
Admin clicks "Request documents" on the vendor detail page, ticks recipients
(operational / broker / secondary contacts) and sees exactly who will receive it
        │  sendRequest() — runs AS the admin, via their session cookie
        │  prepare_contact_request() re-derives the recipients server-side,
        │  excludes suppressed addresses, inserts the request (fresh token hash)
        ▼
vendor_upload_requests row created, token generated, hashed, magic link built
        │  sendUnlessSuppressed() — re-checks suppression, then Resend if
        │  RESEND_API_KEY is set, otherwise a logged no-op; the link is
        │  returned to the caller either way
        ▼
Vendor opens /vendor-upload/:token — no account, no login
        │  resolveUploadToken() — service-role client, after independently
        │  verifying the hashed token, its expiry, and its status
        ▼
Vendor sees current policies on file, uploads a PDF/JPG/PNG
        │  uploadDocumentForToken() — same validation, then writes to the
        │  private vendor-documents bucket and vendor_documents
        ▼
compliance_queue_items row appended — visible on the existing admin
Compliance Queue screen. vendor_compliance_items is NOT touched: a received
file is not evidence of compliance. That's Phase 2 (extraction) and Phase 3
(the compliance engine).
```

### Two Supabase clients, for two different callers

`src/lib/supabase/serverClient.server.ts` exports both:

- **`getRequestScopedClient()`** — runs every query as the signed-in caller, via
  their session cookie (`@supabase/ssr`, reading/writing cookies through
  `@tanstack/react-start/server`). `sendRequest()` uses this: whether an
  admin may act on a given vendor is decided once, by the `can_write_company()`
  RLS policy, never re-implemented in application code.
- **`getServiceRoleClient()`** — bypasses RLS entirely. Used only by
  `resolveUploadToken()` and `uploadDocumentForToken()`, because the vendor
  opening the link has no Supabase session at all — there is no `auth.uid()` to
  write a policy against. Both functions independently verify the hashed token,
  its expiry and its status before touching a row; the service-role key does not
  replace that check.

The filename matters: this project's Vite config
(`@lovable.dev/vite-tanstack-config`) hard-fails the client build if anything
under a `src/**/server/**` directory, or any `*.server.*` file, is reachable from
client-bundled code. `serverClient.server.ts` is meant to trip that on purpose —
it is only ever imported from inside `createServerFn().handler()` bodies in
`src/workflows/vendorUploadRequests.ts`, which itself lives in `src/workflows/`
(not `src/server/`) specifically so its exported RPC stubs _can_ be imported by
`VendorUploadPortal.tsx` and the vendor detail page. Verified at
`bun run build` time by grepping `.output/public` for the service-role path —
see the PR for that check.

### Token security

`src/workflows/uploadTokens.ts` (pure, unit-tested, no I/O):

- 256 bits of entropy from `crypto.getRandomValues`, base64url-encoded for the
  URL.
- Only the SHA-256 hash is stored (`vendor_upload_requests.token_hash`); a dump
  of that table hands out no working links.
- 14-day expiry; status transitions (`pending → email_sent → opened → uploaded`)
  gate whether a token can still be resolved or uploaded against.
- Storage paths are server-generated
  (`company/{companyId}/vendor/{vendorId}/documents/{documentId}.{ext}`) from a
  `documentId` created before the object is written — never derived from a
  client-supplied file name.
- One error message for every invalid-token case (expired, wrong status, not
  found). Distinguishing them would let a caller narrow their guesses.

## Document intelligence (Phase 2)

```
Document lands in vendor_documents (Phase 1)
        │  uploadDocumentForToken() checks vendor_id + sha256 for an earlier
        │  document already successfully processed - if found, its result is
        │  copied instead of paying for a second identical extraction
        ▼
getDocumentExtractor().extract() - src/workflows/documentExtraction.ts
        │  claude-opus-5, given the PDF/JPG/PNG directly as a document/image
        │  content block, prompted for one JSON object matching
        │  InsuranceExtractionSchema
        ▼
parseExtractionResponse() - strips a markdown fence if present, JSON.parse,
normalizePolicyType() on each policy (carrier-facing synonyms -> the
vendor_policies enum), then zod validation
        ▼
vendor_documents.parsed_data / extraction_confidence / processing_status set
        │  overall_confidence >= 0.6 -> 'processed', below -> 'needs_review'
        │  a thrown error, a refusal, or invalid JSON -> 'needs_review'/'failed'
        ▼
'needs_review' or 'failed' bumps the matching compliance_queue_items row to
'in-review' - a clean 'processed' result leaves it exactly where Phase 1 left
it: still awaiting a person's own review, not auto-approved.
```

**No OCR, no `pdf-parse`.** The original design for this phase split text
extraction and OCR into two steps with a fallback between them. Claude reads a
PDF or image document block directly and handles a scanned certificate the
same way it handles a machine-generated one - there is no separate OCR path to
fall back to, and no native PDF-parsing dependency to keep working across a
Cloudflare Workers deployment target (nitro's default build target - see
`vite.config.ts`).

**Document classification is folded into the same call.** Rather than a
separate step, `document_type` (e.g. `"ACORD_25"`) is one field the extraction
already returns.

**Confidence gates trust, not correctness.** `processed` does not mean
"compliant" - a document that extracts cleanly with `additional_insured: false`
is `processed`, and correctly so; that value still has to be checked against
what a client actually requires, which is Phase 3's job. `processed` means
"the model read this confidently enough that Phase 3 could reasonably act on
it without a human looking first." The extraction prompt is written to prefer
`null` and a lower `overall_confidence` over guessing - see the prompt in
`documentExtraction.ts` for the specific instruction not to infer
additional-insured/waiver status from a certificate's own checkbox alone,
since a certificate of insurance typically states outright that it confers no
rights and does not amend the referenced policies; that status is properly
shown by an attached endorsement form (CG 20 10, CG 20 37, CG 24 04), which
the model may not have been given.

**`reprocessDocument()`** is the retry path for `'failed'` (including the
`ANTHROPIC_API_KEY`-unset case, which is stored as `'failed'` with
`processing_error` naming the real reason) or a transient error. It runs
entirely on the request-scoped client - the caller is a signed-in admin, so
the same `can_write_company()` RLS policy that gates every other
`vendor_documents` write gates this too; there is nothing here a service-role
bypass is needed for.

**Duplicate detection is scoped per vendor, not global** - the same COI
legitimately gets re-uploaded for different vendors (a broker's template).
`vendor_documents_sha256_idx (vendor_id, sha256)` from Phase 1 already
supports the lookup; this phase is what actually reads it.

## The compliance engine (Phase 3)

Two independent gates decide whether a document's data reaches
`vendor_policies`, and a document must clear both:

1. **Confidence (Phase 2)** - `overall_confidence >= 0.6`, or the extraction
   never reaches `processed` at all.
2. **A deterministic match (Phase 3, `src/workflows/complianceEngine.ts`)** -
   the LLM's confidence in itself never gates a database write; a second,
   independent check does. `matchExtractedPolicy()` auto-renews a policy only
   when, against the vendor's existing active policy of that type, the
   carrier matches, the policy number matches, and the new expiration date is
   strictly later. Anything else - a new carrier, a changed policy number, a
   date that didn't move forward, or simply no existing policy of that type
   to compare against (`new_coverage` - a vendor's _first_ submission for a
   coverage type is deliberately never auto-applied) - requires a human
   decision instead.

```
extraction reaches processing_status = 'processed' (Phase 2)
        │
        ▼
for each classified policy on the certificate, independently:
        │  a GL + WC + Auto certificate can cleanly renew GL while WC needs
        │  a look - each policy is judged on its own, not the whole document
        ▼
matchExtractedPolicy(extracted, existing active policy of that type)
        │
   ┌────┴─────────────────┬───────────────────────┐
   ▼                      ▼                        ▼
'renew'                'new_coverage'          'needs_review'
   │                  (no existing policy    (carrier/number/date
   │                   of this type to        mismatch, or missing/
   │                   compare against)       unparseable data)
   ▼                      │                        │
apply_policy_renewal() ---┴────────────────────────┘
(RPC, atomic: supersedes         no vendor_policies write;
 the old row, inserts the        vendor_documents.review_reason
 new one, all-or-nothing)        records why
   │
   ▼
general_liability specifically also recomputes the compliance rail
(coi / additionalInsured / waiverOfSubrogation / renewal) via
computeComplianceItems() - a non-GL renewal (WC, Auto, Umbrella) still
updates vendor_policies but does not move the rail
        │
        ▼
any policy on the certificate that didn't cleanly renew downgrades the
WHOLE document from 'processed' to 'needs_review' (compliance_queue_items
bumped to 'in-review', same as a low-confidence Phase 2 result) - a
document is only "processed" once every coverage type on it cleared both
gates
```

**`apply_policy_renewal()` is a Postgres function, not application code, and
deliberately not `security definer`.** Superseding the old policy row and
inserting its renewal has to be atomic - the table's own
`vendor_policies_one_active_per_type` unique index allows only one `'active'`
row per `(vendor_id, policy_type)`, so two separate statements risk leaving a
vendor with _zero_ active policies of that type if the second one fails. One
RPC call is one transaction. Because it is not `security definer`, every
statement inside runs with the **caller's own** row-level permissions - the
same `can_write_company()` RLS policy that gates a direct `vendor_policies`
write gates a call to this function too. `supabase/tests/compliance-engine.test.ts`
verifies this doesn't just work for the happy path: a `read_only` member is
refused, an owner cannot act on another company's vendor through it, `anon`
cannot execute it at all, and a deliberately-broken renewal (an insert that
violates a CHECK constraint) rolls back the _entire_ call - the earlier
`UPDATE` included - so the old policy is never left superseded with no
replacement.

**Null is never silently read as compliant.** The Phase 2 extraction prompt
instructs the model to return `null` for `additional_insured`/
`waiver_of_subrogation` rather than guess from a checkbox alone.
`computeComplianceItems()` treats that `null` the same as never having been
provided at all - `"missing"`, not `"compliant"` and not a false negative
either. A certificate that explicitly says `false` also reads as `"missing"`:
"the certificate says no" and "the certificate couldn't determine this" both
mean the requirement isn't satisfied yet, which is the only fact the rail
needs to convey.

**Carried coverage limits need nothing updated here at all**, unlike every
other write in this section - `vendor_policies.each_occurrence_limit`/
`general_aggregate_limit` are already updated precisely, by `policy_type`,
by `applyOnePolicyLine()` above. `toCoverageLimits()`
(`supabaseRepository.ts`) reads them from there live, matched against
`compliance_requirements` by `policy_type` - see
[Matching against coverage requirements](#matching-against-coverage-requirements).
This used not to be true: `vendor_coverage_limits` paired `required_amount`
with a `carried_amount` column under a free-text `label` with no fixed
vocabulary tying it to a `policy_type`, so there was no reliable way to
auto-update it - see migration 13.

### Notification emails

`notifyDocumentOutcome()`, called at the end of `applyExtractionResult()`,
sends two kinds of email once a document's final `processing_status` is
known - the vendor's own upload experience was otherwise just an in-browser
"thanks", with no way to learn later whether anything actually happened:

- **`document_received`, to the vendor, always** - outcome-dependent copy
  (`documentOutcomeCopy()` in `emailTemplates.ts`) that deliberately never
  repeats the specific matching-engine reason for `needs_review`/`failed`. To
  a vendor, `"Carrier changed: 'Travelers' on file, 'Hartford' extracted"`
  reads as unexplained internal jargon at best, or an invitation to argue
  with an automated decision at worst - they get reassurance and a "we'll
  follow up," not the diagnosis.
- **`admin_review_needed`, to the company's owner(s), only when a human needs
  to act** - carries the specific reason (`review_reason` or
  `processing_error`), since the person reading this one is the one who has
  to act on it. Resolved via `company_members` (`role = 'owner'`) joined to
  `profiles` for the email address - both reads already covered by existing
  RLS (`shares_company_with()` lets a company member read a fellow member's
  profile).

Wrapped in a try/catch that swallows everything: a notification failure must
never surface as an upload or reprocess failure. The document and its
`processing_status` are already committed by the time this runs: nothing
useful to do with a send error beyond not letting it propagate. Every attempt,
including a failed one, is still recorded in `email_outbox` - the same
pattern `createUploadRequest()` already used in Phase 1.

### Renewal reminders

Migrations 9/10 close the last gap Phase 3 deliberately left open: nothing
prompted a vendor before their certificate actually expired. A daily job now
emails at 90, 60, 30, 14, and 7 days out, keyed off `general_liability` for
the same reason as everywhere else in this schema — it's the policy that
drives `computeComplianceItems()`.

Split across two layers because they need very different things to verify:

- **Detection is plain SQL**, fully covered by `db:verify`:
  - `policy_reminder_log` records which tier has already fired for which
    policy (`unique (policy_id, days_threshold)` — the constraint that makes
    the whole system idempotent).
  - `current_reminder_threshold(days_until)` picks the single _tightest_
    applicable tier for a day-count (45 days left resolves to 60, not 90), so
    a daily job sends exactly one reminder per threshold crossed rather than
    a backlog.
  - `policies_due_for_reminder` is the view a scheduled job actually reads:
    active GL policies whose current threshold has not already been logged.
    A renewal resets the cycle for free — `apply_policy_renewal()` always
    inserts a new `vendor_policies` row rather than mutating the old one, and
    the log is keyed by `policy_id`, so a fresh row starts with no log
    entries and the 90-day tier is immediately available again.
- **Scheduling and sending need the real stack**: `pg_cron` (a background
  worker) and `pg_net` (real outbound HTTP) don't exist in PGlite, so
  migration 11 is excluded from `db:verify` (`SKIPPED_IN_PGLITE` in
  `supabase/tests/harness.ts`) and verified instead against the live project
  — `get_advisors` after applying, then a direct `curl` invocation of the
  deployed function (done for this phase; see the commit history for the
  exact commands).

**How the pieces connect**, once deployed:

```
pg_cron (13:00 UTC daily)
  -> pg_net: POST https://<ref>.supabase.co/functions/v1/send-renewal-reminders
       Authorization: Bearer <service_role_key>   (both read from Supabase Vault by name)
  -> Edge Function (Deno, supabase/functions/send-renewal-reminders/)
       - confirms the caller's JWT role is service_role (defense in depth on
         top of the platform's own verify_jwt=true check)
       - reads policies_due_for_reminder
       - per policy: creates a fresh vendor_upload_requests row + magic-link
         token (same shape as createUploadRequest(), Phase 1)
       - sends via Resend, or logs a stub result if RESEND_API_KEY is unset
       - writes email_outbox always; writes policy_reminder_log ONLY on an
         actual successful send — a failed or not-configured send is left
         unlogged on purpose, so tomorrow's run retries it. The log's job is
         to stop double-SENDING, not to mark a threshold "handled" when
         nothing went out.
```

The Edge Function duplicates `uploadTokens.ts`'s Web-Crypto-only helpers and
writes its own `renewal_reminder`-specific copy in
`supabase/functions/send-renewal-reminders/emailTemplates.ts` (worded as an
automated nudge — "expires in 30 days" — rather than the manually-triggered
`renewal_request` template's "please send an updated certificate", since the
vendor didn't just ask for this). Neither file is imported from `src/` — this
runs in Supabase's Deno Edge Runtime, a separate deployment target with no
shared build step across that boundary, which is also why
`supabase/functions/**` is excluded from this project's own `tsc`/`eslint`
(see the `@ts-nocheck` docblock at the top of `index.ts`).

`project_url` and `service_role_key` live in Supabase Vault
(`select vault.create_secret(value, name)`), not in a migration file — the
migration's `cron.schedule()` call only stores that command as text; it
isn't evaluated until the job actually fires, so the migration can be
applied before the secrets exist or the function is deployed. `RESEND_API_KEY`
and `APP_URL` are Edge Function secrets (set once per project outside git,
same as `RESEND_API_KEY` in the Node app's own `.env`) — unset today, so the
function currently runs in the same graceful stub mode as `getEmailSender()`
does locally: it still creates the upload request and records the attempt in
`email_outbox` (`status = 'queued'`), it just doesn't call Resend, and
because nothing was actually sent, `policy_reminder_log` stays unwritten and
tomorrow's run tries again.

### The review queue screen

Closes the gap the README used to list under "What is still not built": a
`needs_review`/`failed` document had no screen to actually look at
`parsed_data`/`review_reason` on, or to approve/reject by hand - staff had to
wait for the vendor to send a _new_ certificate that happened to match
cleanly. Staff-only (`/dashboard/admin/compliance/$queueItemId`,
`AdminGuard`-gated same as the queue list it opens from), it shows what the
certificate extracted side by side with what's currently on file per
coverage type, and lets a reviewer apply selected lines or reject the document.

Two decisions worth being explicit about:

- **Approve applies only the policy types the reviewer confirms**
  - the reviewer starts with every classified line selected, can deselect any
    line, and sees an inline confirmation stating how many selected lines will
    be applied and how many will remain unchanged. `resolveReviewItem()`
    re-reads `parsed_data` fresh from the database (never a client-supplied
    payload), uses the client-supplied policy types only as a validated filter,
    and calls the same `apply_policy_renewal()` RPC the automated path uses for
    each selected classified line. The skipped types are retained in the audit
    entry. This also means a `new_coverage` line (the vendor's first policy of
    a given type, which the automated path can never apply on its own -
    `matchExtractedPolicy()` returns `new_coverage`, not `renew`, and only
    `renew` auto-applies) can finally be recorded through this screen.
- **Staff act across companies they don't belong to, on purpose, through the
  service role.** `vendor_policies`/`vendor_documents`/`compliance_queue_items`
  writes and the storage bucket's read policy all gate on company membership
  (`can_write_company()`/`current_company_ids()`) with **no** platform-admin
  bypass - by design, so a customer's data stays writable only by that
  customer's own members and by nothing else, in every other path through
  this schema. `assertPlatformAdmin()` (`vendorUploadRequests.ts`) confirms
  the caller really is staff via `is_platform_admin()` on the request-scoped
  client - RLS-checked, cannot be spoofed - before `getReviewQueueItem()`/
  `resolveReviewItem()` (`documentReview.ts`) and the now-fixed
  `reprocessDocument()` switch to the service role for the actual reads and
  writes. This was a real, pre-existing bug in `reprocessDocument()`: its own
  docblock claimed the request-scoped client was sufficient because "the
  caller is a signed-in admin," conflating platform-admin session with
  company membership - the one screen that could ever call it (this one) is
  staff-only, and staff are almost never members of the customer's company
  whose document they're reviewing. Fixed as part of building this screen,
  not left for later.

Migration 12 (`20260902000700_review_queue.sql`) is what makes the link
exact: `compliance_queue_items.document_id` replaces `reprocessDocument()`'s
former approximation ("the vendor's most recently created queue item",
wrong once a vendor has more than one upload in flight), and
`resolution`/`resolution_note`/`resolved_at` plus a new `'resolved'` state
give a resolved item somewhere to go - `listQueue()` now excludes it, since
the queue's own subtitle is "awaiting reviewer action," while the outcome
stays on the row for anyone who opens it directly.

### Matching against coverage requirements

Migration 13 closes the last gap the compliance engine had left open since
Phase 3: it could tell you whether a renewal was internally consistent with
what was already on file, but never whether a vendor actually carried what
the client _requires_. A clean renewal of an already-under-limit policy
sailed through unchanged, forever.

`compliance_requirements` is the missing half - what a company requires,
company-wide (not per-vendor: "every sub must carry $2M GL" is a company
policy, not a per-vendor fact; per-trade/per-contract tiering is real future
work, see Known compromises), each row naming both a `policy_type` and which
`vendor_policies` column (`limit_field`: `each_occurrence_limit` or
`general_aggregate_limit`) it checks - the piece that makes a requirement
machine-comparable against an extracted certificate for the first time,
not just a second copy of a number a human already knew.

Two places read it:

- **`matchExtractedPolicy()`** (`complianceEngine.ts`) now takes the
  requirements for the extracted policy's type as a third argument, and
  checks them _last_ - after carrier, policy number, and date have already
  passed - so an otherwise-clean renewal that falls below a required limit
  still gets a specific `needs_review` reason instead of auto-applying. A
  missing/null extracted amount fails the check the same as an explicit
  shortfall - never silently passed, the same tri-state rule
  `computeComplianceItems()` already follows. `new_coverage` lines are never
  checked - they never auto-apply regardless of amount, so there is nothing
  the check would change. The review screen's approve action deliberately
  bypasses this (see Known compromises) - a human override, same as it
  overrides every other reason.
- **`toCoverageLimits()`** (`supabaseRepository.ts`) is what a vendor's
  detail page actually renders: for each of the company's requirements, the
  vendor's own **active** policy of that `policy_type` supplies the carried
  amount, read live - 0 if the vendor carries no active policy of that type
  at all (including "only an expired one"). This is the same
  `vendor_coverage_limits` UI, `CoverageLimit`, unchanged - only where the
  numbers come from changed. `vendor_coverage_limits` itself is dropped, not
  migrated: nothing ever wrote to it besides `supabase/seed.sql`'s sample
  data, and its `carried_amount` column was a second, never-auto-updated
  copy of a number `vendor_policies` already tracks precisely.

### Audit log

The first piece of Phase 4 hardening: every prior phase either superseded a
row (`vendor_policies` - a renewal keeps the old row with
`status='superseded'` rather than overwriting it) or left an implicit trail
in a workflow-specific table (`email_outbox`, `policy_reminder_log`).
Neither answers "which staff member approved this, and when" for the two
actions that most need it - a human review decision (`resolveReviewItem()`)
and a manual retry (`reprocessDocument()`) - both of which run on the
service role after `assertPlatformAdmin()`, so there was previously no
record of _who_ acted at all, only what happened and when.

`audit_log` is deliberately scoped to the three server-function write paths
that had no actor trail of their own - `upload_request_created`
(`createUploadRequest()`), `review_resolved` (`resolveReviewItem()`),
`document_reprocessed` (`reprocessDocument()`) - not every mutation in this
schema; widen the `action`/`target_type` CHECK constraints as more actions
need this rather than trying to cover everything in one pass (see Known
compromises).

**Attributing a service-role write to a real actor** needed its own small
piece: `assertPlatformAdmin()` now returns the caller's own user id (a
second RPC, `current_user_id()`) alongside its existing yes/no check, since
`resolveReviewItem()`/`reprocessDocument()` proceed on the service role,
which has no bound session for `auth.uid()` to resolve. `createUploadRequest()`
needs none of this - it writes on the request-scoped client, where a `BEFORE
INSERT` trigger (`set_audit_log_actor()`) fills `actor_id` from `auth.uid()`
automatically whenever a caller leaves it unset. That trigger exists instead
of a plain column default specifically because a plain `default auth.uid()`
does not work here: `authenticated` has no `USAGE` on schema `auth` in this
project (confirmed by the same "permission denied for schema auth" the
harness reproduces for any direct, non-security-definer `auth.uid()`
reference) - every other direct read of it already goes through a
`security definer` wrapper (`current_company_ids()`, `is_platform_admin()`),
and this trigger is that wrapper for a table default. `db:verify` caught
this before it ever reached the live project - see
`supabase/tests/audit-log.test.ts`.

**A real, confirmed bug found and fixed while building this**: two existing
PostgREST embedded selects - `company_members -> profiles ( email )` used by
both `notifyDocumentOutcome()`'s admin-owner-email lookup and
`listAccessGrants()` (the Access & Permissions screen) - have never worked.
`company_members.user_id` and `profiles.id` both independently reference
`auth.users`; neither table has a foreign key to the other, so PostgREST has
no relationship to embed through. Confirmed live with a direct REST call
(`PGRST200: Could not find a relationship between 'company_members' and
'profiles'`), not a guess. `notifyDocumentOutcome()`'s version failed inside
a try/catch that swallows every notification error on purpose (a bad send
must never undo the extraction work that already committed) - so
`admin_review_needed` has never actually reached a company owner.
`listAccessGrants()`'s version had no such catch, so the Access &
Permissions screen has never successfully loaded live data at all. Both
fixed the same way: two queries (`company_members.user_id`, then
`profiles` filtered `.in("id", ...)`) instead of one embed - see
`fetchOwnerEmails()` in `vendorUploadRequests.ts`.

### Cancelling an upload request

The second piece of Phase 4 hardening, and the smallest kind of gap this
project has closed so far: `vendor_upload_requests.status` has allowed
`'cancelled'` since migration 4 (Phase 1), and
`vendor_upload_requests_open_idx` has excluded it from "still open" queries
for just as long - the schema was built expecting this from day one, but no
code ever set it, and there was no admin control to call off an outstanding
request.

`cancelUploadRequest()` (`vendorUploadRequests.ts`) is that missing write.
No new table, no new RLS policy: `vendor_upload_requests_update` already
grants `can_write_company()` the UPDATE this needs, the same policy the
request INSERT already relies on - this runs entirely on
the request-scoped client, no service role anywhere. Only valid from a
status the vendor hasn't acted on at all yet
(`canCancelRequest()` in `uploadTokens.ts` - `pending`/`email_sent`/`opened`,
deliberately the same members as `canOpenRequest()`'s set today, but named
separately since "the vendor can still open this link" and "an admin can
still call this off" are different questions that only happen to share an
answer right now) - re-checked server-side, not just hidden by the UI, since
the status could move between the page loading and the click landing.
Logged to `audit_log` as `upload_request_cancelled` /
`vendor_upload_request` (migration 15 widens both CHECK constraints for it).

The vendor detail page's communication history shows every request with a
"Cancel link" button next to whichever ones `canCancelRequest()` says
qualify. (`listUploadRequestsForVendor()` still exists as a plain read.)

### Malware scanning

The third piece of Phase 4 hardening: before this, an upload was checked
only by `isAllowedUploadMimeType()` and a file-size CHECK constraint - both
metadata a client fully controls, neither able to say anything about what
is actually inside the bytes.

`getMalwareScanner()` (`malwareScanner.ts`) is the same pluggable-provider
shape as `emailSender.ts`/`documentExtraction.ts`: a real VirusTotal-backed
lookup when `VIRUSTOTAL_API_KEY` is set, a stub reporting `not_configured`
otherwise - never throwing either way. It is a **hash** lookup
(`GET /files/{sha256}`), not a full upload-and-scan: `uploadDocumentForToken()`
already computes `sha256` for duplicate detection, so wiring this in costs
nothing extra at upload time, and VirusTotal's actual upload-and-scan
endpoint is asynchronous (submit, then poll an analysis id) - it does not
fit a synchronous upload response without either blocking the vendor for an
unpredictable length of time or building a separate polling/webhook flow.

The real limit that leaves: a hash VirusTotal has never analyzed before -
true of most certificates, which are essentially unique per vendor and
renewal - comes back `'unknown'`, deliberately distinct from `'clean'`
(analyzed, zero engines flagged it). This catches a **reused** malicious
file, not a **novel** one. See Known compromises.

This is also the one integration in this project that _blocks_ rather than
degrading gracefully: every other provider still lets the request through
when unconfigured or failing, because nothing else here is unsafe to
proceed without. Only a confirmed `'malicious'` verdict refuses the upload
outright, before anything is written to storage or the database -
`'not_configured'`/`'unknown'`/`'error'` all still proceed, recorded on
`vendor_documents.malware_scan_status` for anyone who wants to check later.

### Automated retry queue

The fourth piece of Phase 4 hardening. `reprocessDocument()` has been the
only way to retry a `'failed'` document since Phase 2 - an admin has to
notice a document sitting in the queue and click a button. Nothing
automated re-attempted extraction on its own.

Same split as [Renewal reminders](#renewal-reminders), same reason:
detection is plain SQL (`documents_due_for_retry`, migration 17), fully
covered by `db:verify`; scheduling and the actual retry need the real
stack (`pg_cron`/`pg_net` -> the `retry-failed-documents` Edge Function),
verified against the live project instead. `documents_due_for_retry`
surfaces a `'failed'` document that hasn't hit the retry cap, isn't still
on backoff cooldown, and whose linked `compliance_queue_items` row isn't
already `'resolved'` - if a human already looked at this exact document and
chose reject, retrying it forever afterward would be wasted work, not a
service (`resolveReviewItem()`'s reject path leaves
`vendor_documents.processing_status` untouched, so a `'failed'` document
with an already-rejected queue item is a real case, not a hypothetical
one).

**Deliberately conservative**, more so than the reminders Edge Function: a
successful automated retry is _always_ written as `'needs_review'`, never
`'processed'` - `'processed'` means more here than "confidently extracted."
In the original upload path (`applyExtractionResult()`), it means
confidently extracted _and_ cleanly applied to `vendor_policies` by
`applyComplianceEngine()`. Porting that matching/writing logic to Deno
would be a much bigger duplication than the small, pure-function ports this
needs (the extraction schema and the Anthropic call itself); recovering the
_data_ automatically and letting a person decide through the review screen
already built for exactly this (`documentReview.ts`) is the whole job here.
`retry_count`/`next_retry_at` are written _only_ by this automated path,
never by `reprocessDocument()` - they track an automated budget distinct
from a human's own patience manually retrying; see migration 17's
docblock for the full reasoning. Bounded at 5 attempts with widening
backoff (1h, 4h, 12h, 24h, 48h) rather than retried forever: a document
still failing after 5 automated attempts most likely has a real,
non-transient problem an automated retry cannot fix by trying again.

If `ANTHROPIC_API_KEY` is unset, the Edge Function skips the entire run
(not a per-document `not_configured` result - there is no point spending a
database round trip finding documents this run could not possibly process)
and touches nothing, so the next hourly run picks up exactly where this one
left off once the key is set.

### Email bounce handling

The fifth and last piece of Phase 4 hardening - the item this README's own
Known compromises used to flag by name: "split `email_outbox` once
delivery-webhook data (opened/clicked/bounced) needs its own lifecycle."
Before this, `email_outbox.status` answered "did we attempt to send this"
(`queued`/`sent`/`failed`, set once by the app at send time) and nothing
else - never "did it actually reach the vendor," "did it bounce," or "did
they mark it spam."

**`email_delivery_events`** is that split, done as an append-only log rather
than more mutable columns: an email's post-send lifecycle is genuinely
multi-event (sent, then later delivered, or sent then bounced, sometimes a
delay before either), which a single status column can only ever show the
latest of. `email_outbox.status` is still updated for delivery _outcome_
events (`delivered`/`bounced`/`complained`) - a dashboard reading one row
doesn't need to join for the common case - but the event log is the actual
record; status is a derived summary, not the source of truth.

**`supabase/functions/resend-webhook`** is a public HTTP endpoint - the
first one in this project not gated by `verify_jwt`, because Resend has no
Supabase session to attach a platform JWT to. Authenticity instead comes
from Resend's own webhook signing scheme, which is actually Svix's (Resend
delegates the cryptography to Svix and documents it by pointing there
rather than restating it): `svix-id`/`svix-timestamp`/`svix-signature`
headers, HMAC-SHA256 over `{id}.{timestamp}.{raw body}` with a
`whsec_`-prefixed, base64-encoded secret (`RESEND_WEBHOOK_SECRET`). That
algorithm was confirmed against Svix's own published test vector before
writing a line of the verification code - see
`src/tests/svix-signature.test.ts`, which checks the exact vector, several
tamper cases (wrong body, wrong secret, wrong id, an unmatched signature, an
unrecognized version prefix), the multi-signature secret-rotation case, and
the replay-protection timestamp window - not deployed-and-hoped-for.

`verifySvixSignature()` (`svixSignature.ts`) is a rare case in this codebase:
the _same_ file, byte-for-byte, runs in both the Node app (where it is
actually unit-tested, `src/workflows/svixSignature.ts`) and the Edge
Function, because it uses nothing but `atob`/`btoa`/`crypto.subtle` -
identical globals in both runtimes. Every other cross-runtime port in this
project (`uploadTokens.ts`, `insuranceExtractionSchema.ts`) needed at least
an `npm:`/`jsr:` specifier swap; this one needed none, so real unit tests
against the real algorithm were possible in a way they weren't for those.

**This is also the one endpoint in this project that refuses outright rather
than degrading gracefully when unconfigured** - the same posture malware
scanning takes toward a `'malicious'` verdict, for the same reason: an
unset `RESEND_WEBHOOK_SECRET` or a failed signature check returns `401`
immediately, because accepting an unverified call would let anyone forge a
bounce or spam-complaint event against any company's `email_outbox` row.
There is no gentler failure mode to fall back to here. Confirmed live
against the deployed function: with no secret configured (the current
state - see Known compromises), every call is refused with
`401 Webhook not configured`, never a silent pass-through.

An event that doesn't match a known `provider_message_id` (an email this
app never sent, or one sent before this feature shipped) is acknowledged
(`200`) but not recorded - there is genuinely nothing to attach it to.

### Contacts, suppression and communication recovery

Task 7 - the migration this closes is
`20260916000600_contacts_and_suppression.sql` (plus a small follow-up,
`20260916000700_contacts_and_suppression_fixups.sql`, after `get_advisors`
flagged a missing `search_path` pin and an unindexed FK). Two additive
pieces, plus a generalized send path:

**`contacts`/`vendor_contacts`** - a company-scoped address book, separate
from `vendors.contact_name`/`contact_email` (which stay exactly as they
are: a Phase 0-era single free-text pair, never migrated by this
migration). One contact can link to several vendors; one vendor can have
several contacts, each tagged `operational`/`broker`/`secondary` via
`vendor_contacts.role`. Cross-tenant integrity is enforced the same way
every other vendor-scoped child table in this schema enforces it -
`assert_company_matches_vendor()` (migration 2) plus a new
`assert_company_matches_contact()`, both firing regardless of caller/role.
RLS is uniformly `can_write_company()` for insert/update/delete, matching
`compliance_requirements`' shape rather than `vendors`' owner/risk_manager-
only delete: a contact is operational address-book data, not something
whose deletion destroys compliance history.

**`suppressed_recipients`** - an active "do not auto-email this address"
list, company-scoped, one row per `(company_id, email)` (a second bounce
refreshes the row rather than duplicating it). Closes the exact gap this
README's own Known compromises used to name: "A bounce/complaint does not
trigger any follow-up action." Written automatically by
**`handle_bounce_suppression()`**, an `AFTER INSERT` trigger on
`email_delivery_events` (migration 19) - not new code in the
`resend-webhook` Edge Function itself. That function already inserts one
`email_delivery_events` row per bounce/complaint it receives; a trigger on
that insert gets the suppression logic for free, without teaching
`resend-webhook` anything about `suppressed_recipients` or `tasks`. It also
means the behavior is provable through the same PGlite harness every other
schema invariant here is (`supabase/tests/communications.test.ts`: insert a
bounced/complained event, assert a suppression row and a high-priority
`tasks` row appear, assert a `sent`/`delivered`/`delivery_delayed` event is
a no-op, assert cross-tenant isolation) rather than only checkable against
the live Edge Function - the same database-layer-over-application-code
preference already established for `assert_company_matches_vendor()` and
friends.

**`sendRequest()`** (`src/workflows/communications.ts`) sends a request to
any set of a vendor's linked contacts - send-to-vendor, send-to-broker,
send-to-both. Since 20260922120000 it is the **only** request path: the
old single-recipient `createUploadRequest()` (which mailed
`vendors.contact_email` with no suppression check) has been deleted, and
its two callers (vendor detail, bulk-import dispatch) moved onto
`sendRequest()`. See [Vendor contacts and suppression-safe request
delivery](#vendor-contacts-and-suppression-safe-request-delivery) for the
current design. Contracts worth calling out explicitly:

- **Every resend is a brand-new `vendor_upload_requests` row and a brand-new
  token** - `sendRequest()` never extends or reuses an existing request,
  mirroring `cancelUploadRequest()`'s own "the old request stays exactly
  what it was" discipline (see [Cancelling an upload
  request](#cancelling-an-upload-request)).
- **`confirmedRecipientIds` is the only way to name who receives mail** -
  there is no "resend to whoever was on the previous request" shortcut.
  "Resend requires recipient confirmation" (the plan's own wording) is
  enforced by this being the sole recipient input on every call, first send
  or resend alike; a future UI's resend action should re-show the previous
  recipients for a human to confirm or edit, not read them off the old
  request and pass them through silently.
- **Suppressed recipients are excluded and recorded** - a suppressed
  recipient gets an `email_outbox` row with status `suppressed` (so
  communication history shows who was deliberately not emailed) and no
  send; every other recipient in the same call still gets attempted. A
  selection where _every_ recipient is suppressed is refused outright and
  creates no request at all.

`src/data/repositories/contactRepository.ts` is the read/write layer the
vendor detail page's Contacts panel and communication history consume
(through `src/workflows/vendorContacts.ts`):
listing/creating contacts and vendor links, checking/listing suppressions,
and `listCommunicationHistoryForVendor()` - `email_outbox` joined with its
full `email_delivery_events` history per send, the source for
queued/sent/delivered/delayed/bounced/complained/failed history. That join
is a genuine PostgREST embed (a direct FK, `email_delivery_events.email_outbox_id`
→ `email_outbox.id`), not the no-FK trap documented elsewhere in this
project's history.

**`audit_log`** gains one more action, `contact_request_sent`, widening the
same `action` CHECK constraint migrations 14/15/21 already widened -
`sendRequest()` writes one audit row per call (not per recipient), with
each recipient's role, outcome and outbox id in `detail`.

### Vendor contacts and suppression-safe request delivery

Migration `20260922120000_vendor_contacts_request_delivery.sql` plus the
vendor detail page's **Contacts** panel (`VendorContactsPanel.tsx`) and
**Document requests & communication history** section
(`VendorCommunicationsSection.tsx`).

**Contacts.** Each vendor lists its contacts with name, agency/company
(`contacts.organization`, new), email, phone, role (`operational` /
`broker` / `secondary` - the exact `vendor_contacts.role` values) and any
active suppression, shown in words ("Hard bounce", "Spam complaint", "Do not
email"). Writers can add, edit, link an existing contact, unlink, change
role, and mark/clear do-not-email; read-only members see everything but get
no controls, and RLS refuses the writes regardless. **One contact per
address per company**: `contacts_company_email_unique` on
`(company_id, lower(btrim(email)))` (existing duplicates are merged into the
oldest row first), and "Add contact" links the existing contact when the
address is already known - a broker covering ten vendors is one row linked
ten times, and editing it shows "shared with N vendors". Every vendor's
Phase 0 `contact_email` becomes its `operational` contact (backfilled once,
and by the `vendors_ensure_operational_contact` trigger on every new vendor

- including CSV imports). Contact/link/role/suppression changes are written
  to `audit_log` by `record_contact_audit()`.

**Sending.** `sendRequest()` = `prepare_contact_request()` (SQL, SECURITY
INVOKER, so the caller's own RLS applies) + `sendRequestHandler()` (Node).
The database half: vendor must be visible (else "Vendor not found."), caller
must pass `can_write_company()`, **every** requested contact id must be a
contact of the same company linked to this vendor (one bad id - another
vendor's contact, another company's contact, a made-up uuid - rejects the
whole call and creates nothing), suppressed recipients are excluded and
recorded, an all-suppressed selection is refused, and a resend cancels the
request it replaces (only if the vendor hasn't acted on it). The Node half
generates a **fresh token for every call** (never reused, including resend),
re-checks suppression immediately before each send, writes one
`email_outbox` row per recipient carrying `contact_id` + `recipient_role` +
`upload_request_id`, and one `audit_log` row. The UI shows the exact
"Will be emailed to" / "Excluded" lists before the Send button, and
suppressed contacts cannot be ticked.

**Communication history** groups `email_outbox` rows by request: date,
request type, recipient, role, sent / delivered / bounced / complained /
failed flags (from `email_outbox.status` + `email_delivery_events`, a direct
FK), "Excluded — suppressed", and upload received (the request's
`uploaded_at`/status). **Resend** reopens the composer with that request's
recipients pre-ticked and editable and sends a new request
(`vendor_upload_requests.resend_of_request_id` links the chain).

**Suppression is enforced on every production send path** - every one asks
`public.is_email_suppressed(company_id, email)` before handing an address to
Resend, and fails closed (does not send) if that check errors:

| Send path                                                    | Recipient               | Gate                                                     |
| ------------------------------------------------------------ | ----------------------- | -------------------------------------------------------- |
| `sendRequest()` (vendor detail, resend, CSV-import dispatch) | chosen vendor contacts  | `prepare_contact_request()` + `sendUnlessSuppressed()`   |
| `notifyDocumentOutcome()` (`vendorUploadRequests.ts`)        | vendor contact + owners | `sendUnlessSuppressed()`                                 |
| `inviteCompanyMember()` / `resendCompanyInvitation()`        | invitee                 | `sendUnlessSuppressed()`                                 |
| `send-renewal-reminders` Edge Function                       | vendor contact          | inline `is_email_suppressed` before creating the request |
| `process-document-jobs` Edge Function                        | vendor contact + owners | Deno `sendUnlessSuppressed()`                            |
| `compliance-housekeeping` Edge Function                      | compliance contacts     | Deno `sendUnlessSuppressed()`                            |

`src/tests/suppression-coverage.test.ts` fails the build if any Node file
calls the email sender outside `sendUnlessSuppressed()`, if
`createUploadRequest()` reappears, or if an Edge Function calls Resend
without the gate. **The three Edge Functions must be redeployed** for the
Deno half of this to be live - see Known compromises.

### Pilot-blocker UI: reports, CSV import, reviewer editing, legal pages

Customer UI over backend that already existed (2026-09-22):

- **Reports** (`/dashboard/reports`) - thirteen reports from
  `src/workflows/reportCatalog.ts`, each backed by an existing
  `reportRepository.ts` read (no new report SQL). The only new read is
  `getAssignmentComplianceRows()`, which adds `compliance_cases` so the
  project/trade rollups can say "not yet evaluated" instead of counting an
  unevaluated assignment as compliant. `getReportRows()` (view) and
  `exportReport()` (CSV) both run `assertCompanyMember()` first; only the
  export writes a `report_exported` audit row. The CSV uses the catalog's
  column list, so the file matches the table.
- **CSV import** (`/dashboard/vendors/import`) - upload → preview →
  `validateVendorImportRows()` → explicit confirmation →
  `executeVendorImport()` (idempotent on a key minted once per validated
  file). Validation now also predicts whether each row creates or matches
  the (project, vendor) assignment, using the same oldest-first vendor
  lookup `import_vendor_row()` uses, and rejects fractional contract values
  up front (the column is `bigint`).
- **Migration `20260922140000_import_write_role_and_extraction_immutability.sql`**
  - `import_vendor_row()` now requires `can_write_company()` (owner / risk
    manager / project engineer). It previously accepted any member,
    including `read_only`, because a SECURITY DEFINER function bypasses the
    table write policies - a read-only member could create projects and
    vendors through it. `executeVendorImportHandler()` also checks
    `can_write_company` before attempting any row.
  - `document_extractions` rejects every UPDATE (trigger
    `document_extractions_immutable`); deletes still cascade from
    `vendor_documents`.
  - **Applied to staging and production on 2026-09-22** and confirmed with
    `list_migrations` plus rolled-back live DB checks (a `read_only` member,
    a cross-company caller and an anonymous caller are all rejected `42501`;
    every direct UPDATE on `document_extractions` is rejected `55000`; a
    `reviewer_edit` INSERT still appends and leaves the model row unchanged).
    Function, trigger and grant fingerprints are byte-identical on both
    projects, and the security advisor reported no new warning.
- **Reviewer editing** - see [The review queue screen](#the-review-queue-screen)
  and the Known compromises entry above.
- **`/terms` and `/privacy`** - factual descriptions only, every commitment
  section marked "Pending legal/product approval".

### Deployment verification

Two operational checks, neither part of the app's own request path -
`scripts/check-email-deliverability.ts` (run by hand, e.g. `bun run
check:email-deliverability [domain] [dkimSelector]`, not on any schedule):

**SPF/DKIM/DMARC** - plain DNS TXT lookups (Node's `dns/promises.resolveTxt`;
acceptable here specifically because this script never runs in the
Cloudflare Workers request path the rest of this project is built for - see
the script's own docblock) against the configured sending domain
(`compliance.vendorclr.com`, matching `FROM_ADDRESS` in
`src/workflows/emailSender.ts`), reporting pass/fail/missing for each. A
resolver failure (no network, a sandboxed environment with no outbound DNS)
is reported as its own failed check rather than crashing the other two -
worth knowing if this script is ever run somewhere network-restricted.

**The signed-webhook round trip** - the same zero-side-effect technique
this project has used since migration 19: `POST` to the deployed
`resend-webhook` function with no (or an invalid) Svix signature and
confirm it refuses with `401`, never `200` or a connection failure. A
`401` here is the _passing_ outcome - it proves the function is live and
that signature verification is actually active, not bypassed:

```bash
curl -i -X POST https://<project-ref>.supabase.co/functions/v1/resend-webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"email.bounced","created_at":"2026-01-01T00:00:00Z","data":{}}'
```

Run live against this project during Task 7 (no signature headers sent):
`401 {"error":"Missing signature headers"}`. That response - rather than
the `401 {"error":"Webhook not configured"}` this README previously
described as the only state ever observed live - means `RESEND_WEBHOOK_SECRET`
is now set on the deployed function (it was not as of migration 19; see
[Known compromises](#known-compromises)). The signature check itself is
still exercised only at the unit level (`src/tests/svix-signature.test.ts`,
against Svix's own published test vector) plus this fail-closed-when-headers-
are-missing round trip - a round trip with a genuinely _valid_ signature
would additionally require the real `RESEND_WEBHOOK_SECRET` value, which
this session does not have and does not need in order to confirm the
endpoint enforces verification rather than skipping it.

### Certificate holder on file

Every certificate of insurance names a "certificate holder" at the bottom -
typically whichever client/GC required the coverage. Extraction has
captured this since Phase 2 (`InsuranceExtractionSchema`'s top-level
`certificate_holder.name`/`address`), but until migration 20 it only ever
lived inside `vendor_documents.parsed_data` - a per-document JSON blob
nothing but the review screen ever read. A company auditing whether its own
vendors actually named it correctly (right legal name, not some other
client entirely, not a typo) had no way to see this without opening a
document's raw JSON by hand.

Denormalised onto `vendor_policies.certificate_holder_name`/
`certificate_holder_address`, same reasoning `carrier_name`/`policy_number`
already live there rather than only in `parsed_data`: this is a durable
fact about "the current policy on file," not something to re-derive from a
document blob on every read. Written by `apply_policy_renewal()` (widened
to two more parameters) alongside everything else a renewal sets - both the
automated match path and a human's review-screen approval go through that
one function, so there's no second place this can drift out of sync with
what was actually extracted.

Surfaced in two places:

- **The vendor detail page** (`VendorDetailPage.tsx`) - a "Certificate
  holder" row in the Record panel, for every vendor, all the time, not just
  ones sitting in the review queue.
- **The review screen** (`DocumentReviewPage.tsx`) - the specific
  document's extracted certificate holder, before a reviewer approves it.

Both compare the extracted name against the signed-in company's own name
(`looksLikeMismatch()`, duplicated in both files - see either one's
docblock) and flag a visible mismatch. This is deliberately a loose,
trimmed/case-insensitive string comparison, not a real legal-name
fuzzy-match (LLC suffixes, DBA names, punctuation all count as a
"mismatch") - see Known compromises. It is a first-pass signal for a human
to look twice at, never a hard compliance gate: the raw extracted text is
always shown regardless, and nothing here blocks approval or auto-apply.
A false "doesn't match" costs a glance; a missed real mismatch is exactly
what a human reviewer is there to catch.

### Feature flags

`company_feature_flags` (migration 21) is a per-company kill switch table,
built ahead of the features it will gate rather than alongside the first one
of them. Seven typed keys exist today - `construction_core`,
`requirement_profiles`, `team_invites`, `submission_packages`,
`deficiency_cases`, `exceptions`, `reports_v2` (`FEATURE_FLAG_KEYS` in
`src/domain/featureFlags.ts`) - none of which back a real schema or screen
yet. **Nothing in the app checks any of them today**; this migration only
adds the switch itself, so a new company cannot be routed into a flow that
doesn't exist.

```sql
create table public.company_feature_flags (
  company_id uuid not null references public.companies (id) on delete cascade,
  key        text not null check (key in (...)),
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (company_id, key)
);
```

Absence of a row reads as disabled - flags default off, and a company need
not have every key populated for that default to hold. Every flag is off
for every company immediately after this migration runs; no rollout has
happened yet.

- **Read**: `isCompanyFeatureEnabled(companyId, key)` in
  `src/domain/featureFlags.ts`. Server-only (it lazily imports
  `getRequestScopedClient()` the same way `vendorUploadRequests.ts` does,
  rather than statically, so this file can stay usable from client code for
  its plain key union without pulling server-only secrets into the client
  bundle). Runs as the signed-in caller, so RLS decides visibility exactly
  as any other read.
- **Write**: `set_company_feature_flag(company_id, key, enabled)`, a
  `SECURITY DEFINER` RPC, same shape as `create_signup_invite()`. It is the
  _only_ way a row is ever written - the table has no insert/update/delete
  policy at all, so a direct write from any client, at any company role, is
  refused by RLS. The function itself re-checks `is_platform_admin()`
  before writing. This is deliberate: these flags gate which incomplete
  product surfaces a company can reach, a platform-staff rollout decision,
  not a tenant self-service setting - a company owner cannot toggle their
  own company's flags, on purpose.
- **RLS**: a member reads only their own company's flags
  (`company_id in (select current_company_ids())`); a platform admin reads
  every company's. Proven in `supabase/tests/feature-flags.test.ts` -
  cross-tenant isolation on select, and that insert/update/delete are all
  refused for a non-admin regardless of company role.

Rollout, when the features behind these flags actually exist, is meant to
go through `set_company_feature_flag()` by hand (or a future admin
screen): the staging tenant first, then named pilot companies one at a
time - never a blanket enable. No company has been enabled for anything as
of this migration.

## Security model

Tenancy is enforced in the database, not in React.

- Every tenant table carries `company_id` and has RLS enabled with no permissive
  default. Read requires membership; write requires a write role.
- `AdminGuard` and the role switcher are **presentation only**. A user who forces
  their way to `/dashboard/admin` still reads nothing — `leads` is staff-only in
  every direction and every customer table is scoped to the caller's company.
- Membership lookups go through `SECURITY DEFINER` helpers
  (`current_company_ids()`, `has_company_role()`). A policy on `company_members`
  that queried `company_members` directly would recurse; the definer breaks the
  cycle.
- Views are declared `security_invoker = true`. Without it a view runs with its
  owner's rights and silently bypasses the RLS of every table underneath.
- Child rows are checked against their parent vendor's `company_id` by trigger.
  The FK and the INSERT policy both pass if you attach a company-A row to a
  company-B vendor; only that trigger catches it.

### `revoke ... from public` does not mean what it looks like it means

Migration 1 originally revoked EXECUTE on every RLS-primitive function "from
public" and granted it back to `authenticated` only, intending `anon` to have
no access. Applied to a real project and checked with Supabase's advisor
(`get_advisors`, type `security`) plus `has_function_privilege('anon', ...)`
directly: **`anon` could still execute every one of them.**

The cause: Supabase applies `alter default privileges in schema public grant
execute on functions to anon, authenticated, service_role` at project
creation. That grants EXECUTE to `anon` and `authenticated` **directly**, at
function-creation time — a separate grant from the one made to the `PUBLIC`
pseudo-role. `revoke ... from public` only revokes the PUBLIC grant; it does
not touch a grant made straight to a named role. The two revokes look
identical in a migration file and do completely different things.

Fixed in `20260902000100_security_and_performance_hardening.sql`, which
revokes from `anon` and `authenticated` by name:

- **RLS-primitive functions** (`current_company_ids()`, `is_platform_admin()`,
  `has_company_role()`, `can_write_company()`, `shares_company_with()`,
  `create_company_for_current_user()`) — revoked from `anon`. `authenticated`
  keeps EXECUTE on purpose: RLS policies invoke these as the querying role
  regardless of `SECURITY DEFINER`, so revoking from `authenticated` too would
  break every policy that calls them. Supabase's advisor still flags these
  five as "callable by authenticated" — expected and correct; that access is
  structural, not an oversight.
- **Trigger-only functions** (`assert_company_matches_vendor()`,
  `assert_task_company_matches_vendor()`, `handle_new_user()`,
  `seed_vendor_compliance_items()`) — revoked from `anon` and `authenticated`
  both. Firing as a trigger never required EXECUTE in the first place; only
  direct invocation (e.g. `/rest/v1/rpc/handle_new_user`) does.

`PGlite` does not reproduce Supabase's default-privileges bootstrap on its
own, so the original bug was invisible to `db:verify` even though it was
exercising these exact policies. The harness now applies the same `alter
default privileges` statement Supabase does (see `BOOTSTRAP` in
`supabase/tests/harness.ts`), and
`supabase/tests/function-grants.test.ts` asserts the intended grant on every
affected function by name — so this class of bug fails a local test run
instead of only showing up in a hosted project's advisor.

### Verifying the boundary

A broken RLS policy fails **silently** — it returns data instead of raising — so
nothing in the app suite would catch a regression. `supabase/tests/` applies these
migrations to a real Postgres and asserts the boundary holds:

```bash
bun run db:verify
```

No Docker and no database service required: it runs on
[PGlite](https://pglite.dev), Postgres compiled to WASM. Same planner, same RLS
engine, same constraint and trigger semantics. Runs in CI on every push.

Covered: migrations apply in order; every table has RLS on; every view is
`security_invoker`; signup provisioning; the compliance-item seeding trigger; the
cross-company child-row trigger; cross-tenant read and write isolation; `read_only`
members; staff read-everything/write-nothing; `seed.sql` including idempotency;
(Phase 1) `vendor_upload_requests`/`vendor_documents`/`email_outbox` tenancy, the
25MB file-size check at the database level, and the `vendor-documents` storage
bucket's RLS — including a regression test for the regex guard in front of the
`::uuid` cast on the folder-segment policy; (Phase 2) the extraction columns'
constraints (confidence between 0 and 1), that `duplicate_of_document_id` sets to
null rather than erroring when its target is deleted, and that two documents for
the same vendor are allowed to share a `sha256` (duplicate detection reads that,
it isn't a uniqueness constraint); (Phase 3) `apply_policy_renewal()` -
superseding the old policy and inserting the new one is genuinely atomic (a
CHECK-constraint-violating renewal rolls back the whole call, old row included),
a `read_only` member and an owner acting outside their own company are both
refused by RLS exactly as a direct write would be (the function is not
`security definer`), and `anon` cannot execute it at all; and (migration 9)
that the widened `email_outbox.template` constraint accepts
`document_received`/`admin_review_needed` while still rejecting anything
outside the allow-list; and (migration 10) `current_reminder_threshold()` at
every tier boundary, `policies_due_for_reminder`'s filtering (GL-only,
active-only, has-an-expiration-date, threshold-not-already-logged, superseded
policies excluded) and cross-tenant RLS isolation, and
`policy_reminder_log`'s uniqueness/check constraints — see
[Renewal reminders](#renewal-reminders) for what migration 11 needs the live
project for instead; and (migration 12) `compliance_queue_items.document_id`
setting to null rather than erroring when its document is deleted, and the
resolved/resolution pairing constraint in both directions (a resolved item
must carry a resolution, a non-resolved item must not); and (migration 13)
`compliance_requirements`' RLS boundary (a `read_only` member cannot create
one, a rival company cannot see one), its `policy_type`/`limit_field` CHECK
constraints, and the one-label-per-company uniqueness; and (migration 14)
`current_user_id()` returning the caller's own id (and null for a session
with no JWT claims), the `set_audit_log_actor()` trigger filling `actor_id`
from `auth.uid()` only when the caller left it unset, every `action`/
`target_type` CHECK constraint, cross-tenant isolation, and - genuinely
provable only at the RLS level, not by a thrown-error assertion - that an
UPDATE or DELETE against `audit_log` with no policy for either matches zero
rows rather than throwing; and (migration 15) that a write-role member can
cancel their own company's outstanding request and the partial index that's
excluded `'cancelled'` since Phase 1 actually reflects it, that a rival
company's UPDATE matches zero rows rather than erroring (same shape as the
`audit_log` case just above), and the widened `audit_log` CHECK constraints
for `upload_request_cancelled`/`vendor_upload_request`; and (migration 16)
`vendor_documents.malware_scan_status` defaulting to `'not_configured'`
rather than null and rejecting a value outside its known set; and
(migration 17) `documents_due_for_retry`'s filtering (`retry_count` cap,
`next_retry_at` cooldown in both directions, already-resolved queue items
excluded, every non-`'failed'` `processing_status` excluded regardless of
`retry_count`/`next_retry_at`) and cross-tenant RLS isolation - see
[Automated retry queue](#automated-retry-queue) for what migration 18
needs the live project for instead; and (migration 19) the widened
`email_outbox.status` CHECK, every `email_delivery_events.event_type`
CHECK, the `assert_company_matches_email_outbox()` integrity trigger firing
on a mismatched `company_id` regardless of caller/role, and cross-tenant
RLS isolation on the events table. `svixSignature.ts`'s cryptography is
covered separately, at the unit level - see
[Email bounce handling](#email-bounce-handling); and (migration 22)
`contacts`/`vendor_contacts` cross-tenant isolation, the
`assert_company_matches_contact()` trigger firing regardless of caller/role
(including when `company_id` matches the _contact_ but not the _vendor_, and
vice versa), the `(vendor_id, contact_id, role)` uniqueness allowing the same
contact to carry two different roles on one vendor, and -
`supabase/tests/communications.test.ts`'s highest-value coverage -
`handle_bounce_suppression()`: a no-op on `sent`/`delivered`/`delivery_delayed`,
an active, lowercase-normalized `suppressed_recipients` row and a
high-priority `tasks` row on `bounced`/`complained`, a second bounce
refreshing the same row rather than duplicating it, a direct manual
suppression/clear by a company writer, and the widened `audit_log.action`
CHECK accepting `contact_request_sent`. The harness stubs a minimal
`storage.objects`/`storage.buckets` schema (PGlite has no `storage` schema of
its own) — see `supabase/tests/harness.ts`.

`src/tests/upload-tokens.test.ts` and `src/tests/email.test.ts` separately cover
the pure token/email logic (no database needed for those).
`src/tests/insurance-extraction-schema.test.ts` covers the extraction schema and
the carrier-string-to-enum normalizer; `src/tests/document-extraction.test.ts`
covers the extraction provider itself against a mocked Anthropic client (no API
key or network call needed) - not-configured, high/low confidence routing,
markdown-fence stripping, invalid JSON, a thrown API error, and a model refusal.
`src/tests/compliance-engine.test.ts` covers `matchExtractedPolicy()` and
`computeComplianceItems()` - every match outcome, the deliberate `null` !=
`"compliant"` handling, that `lienWaiver` is never touched by a
certificate-of-insurance extraction, and (migration 13) the
`compliance_requirements` gate specifically: a shortfall on an
otherwise-clean renewal, a missing extracted amount treated as a shortfall
rather than skipped, checking every requirement rather than stopping at the
first, and that `new_coverage` is never gated at all since it never
auto-applies regardless. `src/tests/supabase-repository.test.ts` covers
`toCoverageLimits()` reading carried amounts live from a vendor's active
policy, by the requirement's own `limit_field`, falling back to 0 for a
missing/superseded/expired policy of the required type.
`src/tests/email.test.ts` also covers the
new `documentReceived`/`adminReviewNeeded` templates specifically for the
property that matters most: the vendor-facing copy never leaks a
matching-engine reason, while the admin-facing copy always includes it.
`src/tests/malware-scanner.test.ts` covers `getMalwareScanner()` against a
mocked `fetch` - not-configured, a 404 (unknown, not clean), clean, malicious
on either `malicious` or `suspicious` alone, and both failure shapes
(a non-2xx response and the network call itself rejecting) reporting `'error'`
without throwing.

`supabase/tests/function-grants.test.ts` asserts the exact anon/authenticated
EXECUTE matrix on every RLS-primitive and trigger-only function — see the
`revoke ... from public` note above for what this specific suite exists to
catch.

**What it does not cover:** `auth.users` and `auth.uid()` in the harness are stubs
matching the shape the migrations depend on. Real GoTrue behavior — email
confirmation, production JWT claim contents, `service_role` specifics — still needs
a real `supabase db reset` before shipping.

## Known compromises

Deliberate, and worth revisiting as later phases grow on top of them:

- **`vendors.trade` stores display strings** (`'Mechanical / HVAC'`) to match the
  `VendorTrade` union 1:1 with no mapping layer. Move to a lookup table before
  trade filtering or localisation.
- **`compliance_requirements` is company-wide, not trade/contract-tiered.**
  Every vendor of a company shares the same required limits today - a real
  construction GC compliance program often wants more (a $50M glazing job
  probably wants a higher GL limit than a $200K one). Deliberately out of
  scope for migration 13: the actual new capability that migration adds
  (limits are machine-comparable at all, for the first time) stands on its
  own without also solving per-vendor tiering in the same pass. See
  [Matching against coverage requirements](#matching-against-coverage-requirements).
- **`compliance_queue_items` is a real table**, now written to by
  `uploadDocumentForToken()`/`reprocessDocument()` as well as staff. A future
  pass should derive it from a real processing-jobs table and drop it.
- **No `document_processing_jobs` table.** Extraction runs synchronously,
  inline in the upload request/response, with exactly one attempt and no
  retry queue - `reprocessDocument()` is a manual, admin-triggered retry, not
  an automated one. A jobs table would track nothing a single row on
  `vendor_documents` doesn't already capture until processing is genuinely
  asynchronous.
- **`compliance_queue_items` has no `document_id` column.**
  `reprocessDocument()` updates the vendor's most recently created queue item
  as an approximation, not the exact one a given document produced - fine for
  a single-document retry, worth fixing before a vendor can have concurrent
  uploads in flight.
- **One company per user.** `resolveCompanyId()` takes the oldest membership.
  Multi-company users need a company switcher in the session context first.
- **The double-redemption race on `signup_invites` is closed by a lock,
  verified only by review.** `handle_new_user()` takes `select ... for
update` on the invite row before checking and marking it used, so two
  concurrent signups racing the same still-pending code should serialize
  rather than both succeeding — see the comment near "rejects a code that
  has already been used" in `supabase/tests/signup-invites.test.ts`. PGlite
  is a single in-memory instance with no genuinely overlapping in-flight
  transactions to race against each other, so nothing here is an automated
  test of the lock itself — the guarantee rests on documented Postgres
  row-locking semantics, verified by manual review, the same category of
  gap as the pg_net/pg_cron skip list and the GoTrue-stub caveat above.
- **`compliance_exceptions` has no internal note.** The table stores
  `reason` (vendor-visible when `vendor_visible` is true),
  `remaining_risk_acknowledged`, dates and the optional supporting document,
  and the approval form (`ComplianceCasesSection.tsx`) asks for exactly
  those - it has no internal-note field (re-checked 2026-09-22; an earlier
  version of this note said the UI collected one, which was not true). An
  internal-only note is a schema change for a later migration, not something
  to fake in the UI.
- **Deficiency reopen on exception expiry relies on the housekeeping sweep**
  (`compliance-housekeeping`, fixed schedule). The expired waiver is shown
  as "Expired — deficiency reopens on the next sweep" until that run
  executes; the UI does not pretend the deficiency is already open, and
  `compliance-case-escalation.test.ts` proves the sweep's reopen is
  idempotent.
- **Whether GoTrue forwards `handle_new_user()`'s exact rejection text
  end-to-end is untested.** The trigger raises a specific message (e.g.
  `'Invalid or expired invite code.'`) on an invalid or already-used invite
  code, but whether Supabase's real GoTrue service passes that string
  through verbatim into the client-visible `signUpError.message`, or wraps
  or genericizes it, can't be exercised from this repo — `harness.ts`'s
  PGlite-based tests insert directly into `auth.users`, bypassing GoTrue's
  HTTP layer entirely, the same class of gap already noted above for
  production JWT claim contents and `service_role` behavior. Confirm
  against a live/staging project before depending on that exact string in
  support docs or QA scripts.
- **No resend UI.** Cancelling an outstanding request is now built (see
  [Cancelling an upload request](#cancelling-an-upload-request)), but there
  is no one-click "resend" - an admin who wants a fresh link has to cancel
  the old request and create a new one as two separate actions.
- **`db-types.ts` is now genuinely generated** (`generate_typescript_types`
  against the live project, migration 21), but `VendorClrClient` is still
  intentionally not parameterised with it, and `supabaseRepository.ts` still
  casts rather than relying on inference - flipping that switch is real,
  separate follow-up work (broader blast radius than this migration wants
  to carry) rather than a mechanical next step. `src/data/dbTypeAliases.ts`
  now sits between the two: `supabase gen types` widens every
  CHECK-constrained `text` column to plain `string` (it can't see a CHECK
  expression's allowed values, only real Postgres enums), so that file
  restores the literal unions (`PolicyType`, `CompanyRole`, etc.)
  `supabaseRepository.ts` relies on, by hand, from `Database`. It is
  deliberately separate from db-types.ts's generated output and needs
  updating by hand if a CHECK constraint changes - see the next item for
  why there's no automated check standing in for that yet.
- **No CI job regenerates and diff-checks `db-types.ts`.** The plan for
  migration 21 called for one, but running `supabase gen types typescript`
  non-interactively needs a `SUPABASE_ACCESS_TOKEN` and project ref as CI
  secrets, and neither is configured in this repo's CI yet. Documented here
  rather than wired up with a job that would only fail outright - add
  `SUPABASE_ACCESS_TOKEN` (and a `SUPABASE_PROJECT_ID` var, currently
  `fzrcowwonezflydicpbd`) to CI secrets, then add a step that runs
  `supabase gen types typescript --project-id "$SUPABASE_PROJECT_ID" >
src/data/db-types.ts` followed by `git diff --exit-code src/data/db-types.ts`.
- **The live project was briefly missing `20260915000100_gated_signup_invites.sql`
  after migration 21 was applied** - discovered while applying migration 21,
  not caused by it, and closed the same day: the migration was applied live
  and `db-types.ts` regenerated, so `signup_invites` is now real generated
  output and `SignupInviteRow` in `dbTypeAliases.ts` uses the derived form
  like every other row type, instead of a hand-authored placeholder.
- **`notifyDocumentOutcome()` emails every company owner individually**,
  rather than one email with every recipient, or a digest. Fine at current
  scale (a company typically has one owner); revisit if a company with
  several owners starts finding this noisy.
- **One reminder run time, no per-company timezone.** `send-renewal-reminders`
  fires at a single fixed 13:00 UTC for every tenant. Fine while every
  customer is US-based and this is the only scheduled job; revisit once
  "which hour" starts to matter to a customer.
- **The Edge Function's `for` loop is sequential, not batched.** Correct at
  current scale (a handful of due policies a day); a company with hundreds of
  policies renewing in the same week would want concurrent sends with a
  concurrency cap, not one HTTP round-trip to Resend at a time.
- **A `not_configured` reminder retries daily with no backoff**, since
  `policy_reminder_log` is only written on an actual send. Fine until
  `RESEND_API_KEY` is set (at which point it stops being reachable at all);
  would need real backoff if a _configured_ Resend integration started
  failing repeatedly for one vendor (a bad address, e.g.) instead.
- ~~**The review screen's approve is all-or-nothing per document, and a
  reviewer cannot edit extracted values.**~~ **Closed.** Approval applies only
  the coverage lines the reviewer selects, and since the pilot-blockers
  change (2026-09-22) the review screen has a field editor that saves a new
  `reviewer_edit` revision through `saveExtractionEdit()` →
  `record_document_extraction()`. The model's own `document_extractions` row
  is never touched; migration `20260922140000` (deployed to staging and
  production 2026-09-22) makes that a database rule (any UPDATE on
  `document_extractions` raises). An approval applies the
  current revision (`vendor_documents.parsed_data`, the cache of
  `current_extraction_id`).
- **The review screen's approve does not block on `compliance_requirements`.**
  A reviewer can knowingly apply a certificate below what the company
  requires - the same human-override reasoning as approving a changed
  carrier. Since 2026-09-22 the vendor's open deficiencies are listed on the
  review screen ("Requirement shortfalls") so the reviewer sees them during
  the decision; they are still not a hard gate on approval, and
  would only become one if reviewers should be prevented, not just
  informed.
- **`audit_log` covers three actions, not every mutation in this schema.**
  Direct `vendor_policies`/`vendor_upload_requests`/etc. writes by a company
  member through the normal dashboard flows leave no audit_log row - only
  the three server functions named in [Audit log](#audit-log) do. Widen the
  `action`/`target_type` CHECK constraints and add the corresponding insert
  as more actions need this kind of trail, rather than trying to instrument
  every write path in one pass.
- **No screen reads `audit_log` as a list.** The review screen shows one
  row's outcome (who resolved _this_ item), which is the only place it's
  wired in today - there is no company-wide or admin-wide "recent activity"
  view yet.
- **The malware scan is a hash lookup, not full-content analysis of a novel
  file.** VirusTotal has almost never seen a given certificate before -
  each is essentially unique per vendor/renewal - so most uploads land on
  `'unknown'`, not `'clean'`. This catches a _reused_ malicious file, not a
  _novel_ one; full-content scanning would need VirusTotal's asynchronous
  upload-and-analyze endpoint (or a different provider offering a
  synchronous scan), a bigger integration than this pass reached for.
- **No admin visibility into scan results beyond the raw column.** There is
  no screen surfacing `malware_scan_status`/`malware_scan_detail` - only a
  `'malicious'` verdict is currently acted on (it blocks the upload
  outright); `'error'`/`'unknown'` results are recorded but not
  highlighted anywhere for a person to notice.
- **A successful automated retry never re-runs compliance matching**, even
  when the recovered extraction would have matched cleanly against what's
  on file. Every recovered document lands as `'needs_review'` and needs a
  person to approve it through the review screen, exactly as if it had
  failed to match automatically the first time - a deliberate, documented
  simplification (see [Automated retry queue](#automated-retry-queue)), not
  an oversight.
- **No admin visibility into the retry budget.** There is no screen showing
  `retry_count`/`next_retry_at`, or which documents have exhausted their 5
  automated attempts and are now waiting on a person via
  `reprocessDocument()`.
- ~~No admin visibility into email delivery/bounce status.~~ **Resolved by 20260922120000.** Vendor detail now shows per-vendor communication history
  (sent/delivered/bounced/complained/failed/suppressed, upload received) and
  each contact's suppression state.
- ~~A bounce/complaint does not trigger any follow-up action.~~ **Resolved
  by Task 7.** `handle_bounce_suppression()` (a trigger on
  `email_delivery_events`, see [Contacts, suppression and communication
  recovery](#contacts-suppression-and-communication-recovery)) now writes an
  active `suppressed_recipients` row and opens a high-priority `tasks` row
  on every bounce/complaint, and `sendRequest()` skips a suppressed
  recipient rather than emailing them again. ~~`createUploadRequest()`'s
  single-recipient path does not check suppression.~~ **Resolved by
  20260922120000:** `createUploadRequest()` is deleted, the customer-facing
  request UI and the import dispatch use `sendRequest()`, and every other
  send path (document-outcome, invitations, and the three mail-sending Edge
  Functions) checks `is_email_suppressed()` first - see [Vendor contacts and
  suppression-safe request
  delivery](#vendor-contacts-and-suppression-safe-request-delivery).
- ~~Edge Function suppression gate needs a redeploy to be live.~~
  **Deployed 2026-09-22** to staging (`ukbgjriqszthtgwxyirr`, after bringing
  it up to date with the four migrations it was missing) and production
  (`fzrcowwonezflydicpbd`): migration applied, then `send-renewal-reminders`,
  `process-document-jobs` and `compliance-housekeeping` redeployed with
  unchanged `verify_jwt` settings. Identical bundle hashes on both projects;
  each boots and refuses a non-service caller (403). A rolled-back SQL smoke
  test as a signed-in owner confirmed suppression exclusion, unrelated-contact
  rejection, all-suppressed refusal, resend cancellation and audit rows on
  both. Deployed via the MCP connector (no CLI token), so the function source
  was transcribed rather than uploaded from disk.
- **Renewal reminders and document-received notices still address
  `vendors.contact_email`** (now always also the vendor's operational
  contact), not the full contact list; they do not yet go to brokers.
  Suppression is enforced on them either way.
- **Company invitations' `email_outbox` insert has no `vendor_id`** (the
  column is `not null`) and a template the CHECK constraint doesn't list, so
  that insert has always failed silently - pre-existing, not changed here;
  invitation sends are still suppression-gated.
- **`RESEND_WEBHOOK_SECRET` is now set as a live Edge Function secret** -
  confirmed during Task 7: the deployed function now refuses an unsigned
  call with `401 {"error":"Missing signature headers"}` rather than the
  `401 {"error":"Webhook not configured"}` this README previously described
  as the only state ever observed live, meaning the secret has been set
  since migration 19 shipped (see [Deployment
  verification](#deployment-verification) for the exact round trip run).
  The _signed_ path (a real secret, a matching signature) is still verified
  only at the unit level (`src/tests/svix-signature.test.ts`, against
  Svix's own published test vector) plus this fail-closed-when-unsigned
  round trip - a live round trip with a genuinely valid signature would
  additionally need the real secret value, which no session so far has had
  reason to read out. `RESEND_API_KEY` itself is also still unset, so no
  real email has gone out to bounce yet either - `suppressed_recipients`
  and `handle_bounce_suppression()` are schema-proven
  (`supabase/tests/communications.test.ts`) but not yet exercised by a real
  bounce end to end. (Whether `RESEND_API_KEY` is now set on production was
  not re-verified in the 2026-09-22 pilot-blockers audit - check the
  Edge Function secrets before relying on this sentence either way.)
- **Certificate-holder mismatch detection is a loose string comparison,
  not a real legal-name match.** `looksLikeMismatch()` (`VendorDetailPage.tsx`,
  `DocumentReviewPage.tsx`) trims and lowercases before comparing - "Halstead
  Builders" vs. "Halstead Builders, LLC" flags as a mismatch even though a
  human would call that correct. Deliberately kept simple: it's a visible
  prompt for a human to look twice, not a gate that blocks anything, so a
  false positive costs a glance rather than a wrong decision. A real
  fuzzy-match (legal suffixes, DBA names, punctuation-insensitive) would be
  a meaningfully bigger feature than "surface what's already extracted."
- **Existing `vendor_policies` rows created before migration 20 have no
  certificate holder on file** - `certificate_holder_name`/`_address` are
  null until that policy's next renewal runs back through
  `apply_policy_renewal()`. The vendor detail page renders that as "Not on
  file," the same as a vendor with no policy at all; there's no backfill
  from `vendor_documents.parsed_data` for rows that predate this column.
- **Escalation thresholds are hardcoded at 3/7/14 days, not yet
  company-configurable.** `compliance_deficiencies_due_for_escalation`
  (Task 10b, `20260917001300_compliance_case_escalation.sql`) fires at
  exactly three fixed thresholds baked into the view's own `where` clause,
  not a per-company setting. This is deliberate, not an oversight: the
  plan's own bullet reads "escalate unanswered correction requests at 3, 7
  and 14 days; make thresholds company-configurable **after pilot
  evidence**" - i.e. configurability is explicitly sequenced to come after
  this ships and real pilots show what actually needs tuning, not before.
  Making it configurable now would mean building a settings UI/column
  around guessed defaults instead of observed ones.
- **Exception expiry "creates a task" as an `audit_log` entry plus an
  email, not a dedicated task-tracking feature.** The plan's exception
  bullet says expiry "reopens the deficiency and creates a task," but this
  codebase has no task-tracking system at all - no `tasks` table, no
  assignment/due-date/status model, nothing a "task" could actually be
  written to. `reopen_expired_compliance_exception()` (Task 10b, same
  migration as above) reopens the deficiency and writes a
  `compliance_exception_expired` row to `audit_log` (this project's
  existing audit trail); the `compliance-housekeeping` Edge Function that
  calls it then emails the company's owner/risk_manager contacts, the same
  `adminReviewNeeded`-style "a human must act" notification pattern
  `process-document-jobs`/`src/workflows/emailTemplates.ts` already use
  elsewhere in this schema. Together, that pairing (a durable record a
  human can look up, plus a real-time nudge to look at it) is the
  deliberate, documented stand-in for "creates a task" in the absence of an
  actual task feature - not a partial or missed requirement. A real task
  row (with its own status/assignee/due date a person can work through)
  would be a meaningfully bigger feature than this bullet's own scope.
- **PDF export is not built - CSV export is.** Task 11b's plan bullet reads
  "CSV/PDF export is generated server-side"; only the CSV half
  (`src/workflows/reportExports.ts`) is implemented. A real server-side PDF
  renderer needs a rendering-library decision (a new dependency) this
  brief's dispatch does not make - hand-rolling a minimal PDF format by hand
  would be a worse outcome than clearly deferring it. Follow-up: pick a PDF
  library (e.g. a headless-Chromium print-to-PDF service or a pure-JS
  generator) and wire it behind the same `exportReport()` entry point,
  reusing the same permission check / `audit_log` row / filename logic - only
  the rendering step itself needs to change.
- **"Pilot metrics" is instrumented via the existing `logOperational()`
  structured-logging infrastructure (Task 2), not a new metrics
  table/pipeline.** The plan's Task 11 bullet says "instrument pilot metrics
  listed in the source requirements" - an external document this session
  does not have access to. Interpreted pragmatically as: add metric-flavored
  `logOperational()` calls, tagged with a `pilot_metric.` event-name prefix,
  at the key compliance-lifecycle events this codebase's own domain model
  already defines and that had no equivalent operational logging yet -
  `pilot_metric.compliance_case_opened` (`complianceCaseRepository.ts`'s
  `applyEvaluationResult()`, logged only on the get-or-create's create
  branch), `pilot_metric.compliance_exception_approved`
  (`approveComplianceException()`), `pilot_metric.csv_import_executed`
  (`executeVendorImportHandler()`, Task 11a's import pipeline, logged only
  for a real execution, never an idempotent replay),
  `pilot_metric.audit_snapshot_created` (`reportRepository.ts`'s
  `createAuditSnapshot()`), and `pilot_metric.report_exported`
  (`reportExports.ts`'s `exportReport()`). Every payload is limited to the
  envelope's own existing fields (`companyId`, `event`, `requestId`,
  `outcome`) with no `extra` object at all - no document text, policy
  numbers or contact PII is ever passed, not merely relied on
  `logOperational()`'s redaction to strip after the fact. Two
  compliance-housekeeping events that predate this task
  (`compliance_deficiency_escalated`, `compliance_exception_expired_reopened`
  in `supabase/functions/compliance-housekeeping/index.ts`) already satisfy
  the same shape (`companyId` + event name, no PII) and are treated as
  already-qualifying pilot metrics; they were deliberately NOT renamed with
  the new prefix, to avoid touching an existing, tested Edge Function's
  event vocabulary for a naming-consistency preference alone. A dedicated
  metrics table/dashboard (aggregation, retention policy, a real analytics
  sink) is out of scope for this task and would be meaningfully bigger than
  "instrument events" - this is a deliberate scope decision, not a silently
  under-delivered requirement.
- **The customer-filtered audit history read (`listCustomerAuditHistory()`,
  `reportRepository.ts`) has no action ever excluded today, but the
  exclusion mechanism (`EXCLUDED_FROM_CUSTOMER_HISTORY`) exists and is
  checked first.** Every current `insert into audit_log` call site (19 total
  as of Task 11b - 9 in SQL migrations, 10 in `src/workflows/*.ts`;
  independently re-counted after this entry's original count undercounted
  them) was read and confirmed to record a real business event scoped correctly by
  `company_id`, including the three staff/`assertPlatformAdmin()`-gated ones
  (`review_resolved`, `extraction_reviewer_edit`, `document_reprocessed`) -
  those represent VendorClr staff acting ON a company's own vendor
  documents as part of that company's own compliance workflow, not a
  platform-admin-only investigative action, so surfacing them to the
  company is the transparency an audit history is for, not a leak. If a
  future action type is ever added that should NOT be customer-visible, its
  action string goes in that array; the property this file documents ("no
  action currently leaks internal-only detail") holds only as of the
  actions that exist today and needs re-checking whenever a new `audit_log`
  write is added, not assumed to hold forever.

## What is still not built

Phases 0-3 gave vendors and policies a real, tenant-scoped home; closed the
outbound half of the loop (request → email → magic link → upload → visible in
the compliance queue); turned an uploaded certificate into structured,
confidence-scored JSON; and, when a deterministic match says it's safe,
applied that JSON to `vendor_policies` and rolled the compliance rail forward
automatically. Phase 4 hardened all of it: an audit log
([Audit log](#audit-log)), the ability to cancel an outstanding request
([Cancelling an upload request](#cancelling-an-upload-request)), malware
scanning on every upload ([Malware scanning](#malware-scanning)), an
automated retry queue for failed extraction
([Automated retry queue](#automated-retry-queue)), and delivery/bounce
tracking on outbound email ([Email bounce handling](#email-bounce-handling)).

Every item originally planned across Phases 0-4 is built, and as of
2026-09-22 so is every customer-facing screen in the go-live blocker plan
(projects, requirement profiles, team and invitations, contacts and
suppression-safe requests, the submission-package portal, deficiencies and
exceptions, reports with server-side CSV export, bulk CSV import, reviewer
editing, and draft `/terms` + `/privacy`). That is not the same claim as
"nothing is left" or "go-live ready" - see [Known compromises](#known-compromises)
for the deliberate simplifications, and
[`docs/operations/go-live-checklist.md`](../docs/operations/go-live-checklist.md)
for what is still open: provider keys per environment (production
Edge Functions reported `ANTHROPIC_API_KEY` unset at the 2026-09-22 deploy),
approved legal text, backups and the restore drill, Turnstile keys, alerting,
and signed-in browser journeys that have never run because no `E2E_*`
accounts exist.

Nothing here claims otherwise: a `processed` extraction that fails
`matchExtractedPolicy()` for even one coverage type on the certificate leaves
`vendor_policies` and `vendor_compliance_items` completely untouched for the
whole document, and `vendor_documents.review_reason` says why.

`company_feature_flags` (migration 21, see [Feature flags](#feature-flags))
adds the kill-switch table and its seven typed keys ahead of the features
they will gate - `construction_core`, `requirement_profiles`,
`team_invites`, `submission_packages`, `deficiency_cases`, `exceptions`,
`reports_v2` back no schema or screen yet, and nothing in the app checks
any of them. They currently gate nothing; a company reading any key today
gets `false` because no row exists, which is correct and by design, not a
gap to close.
