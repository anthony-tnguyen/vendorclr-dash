# Backend: auth, tenancy, the vendor/policy model, and the renewal loop

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
  updates `vendor_policies` when it is, and recomputes the compliance rail.
  See [The compliance engine (Phase 3)](#the-compliance-engine-phase-3).

## What the migrations create

| Migration | Contents |
|---|---|
| `20260901000100_identity_and_tenancy.sql` | `profiles`, `companies`, `company_members`, `platform_admins`, the RLS helper functions, signup provisioning |
| `20260901000200_vendor_domain.sql` | `vendors`, `vendor_policies`, `vendor_compliance_items`, `vendor_coverage_limits` |
| `20260901000300_tasks_queue_leads_and_views.sql` | `tasks`, `compliance_queue_items`, `leads`, and the report/admin views |
| `20260901000400_vendor_upload_requests_and_documents.sql` | `vendor_upload_requests`, `vendor_documents`, `email_outbox`, the private `vendor-documents` storage bucket |
| `20260902000100_security_and_performance_hardening.sql` | Fixes discovered by applying 1-4 to a real project and running Supabase's advisor — see [Security model](#security-model) |
| `20260902000200_document_extraction.sql` | Adds `parsed_data`, `extraction_confidence`, `duplicate_of_document_id` to `vendor_documents` |
| `20260902000300_compliance_engine.sql` | `vendor_documents.applied_policy_id`/`review_reason`, and `apply_policy_renewal()` |

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
`RESEND_API_KEY` to send real email; without it, "Request updated certificate"
still works and returns the magic link directly to the admin to copy and share.
For Phase 2, optionally `ANTHROPIC_API_KEY`; without it a document is still
stored but not extracted (`processing_status` ends up `'failed'`, with
`processing_error` saying so) until `reprocessDocument()` is called after the
key is set. See `.env.example`.

## The renewal loop (Phase 1)

```
Admin clicks "Request updated certificate" on the vendor detail page
        │  createUploadRequest() — runs AS the admin, via their session cookie
        ▼
vendor_upload_requests row created, token generated, hashed, magic link built
        │  getEmailSender() — Resend if RESEND_API_KEY is set, otherwise a
        │  logged no-op; the link is returned to the caller either way
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
  `@tanstack/react-start/server`). `createUploadRequest()` uses this: whether an
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
(not `src/server/`) specifically so its exported RPC stubs *can* be imported by
`VendorUploadPortal.tsx` and `RequestDocumentsAction.tsx`. Verified at
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
   to compare against (`new_coverage` - a vendor's *first* submission for a
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
vendor with *zero* active policies of that type if the second one fails. One
RPC call is one transaction. Because it is not `security definer`, every
statement inside runs with the **caller's own** row-level permissions - the
same `can_write_company()` RLS policy that gates a direct `vendor_policies`
write gates a call to this function too. `supabase/tests/compliance-engine.test.ts`
verifies this doesn't just work for the happy path: a `read_only` member is
refused, an owner cannot act on another company's vendor through it, `anon`
cannot execute it at all, and a deliberately-broken renewal (an insert that
violates a CHECK constraint) rolls back the *entire* call - the earlier
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

**`vendor_coverage_limits.carried_amount` is deliberately not auto-updated
here.** That table pairs `required_amount` (what a client needs) with
`carried_amount` (what a vendor has) under a free-text `label` with no fixed
vocabulary tying it to a `policy_type` - there is no reliable way to match an
extracted `each_occurrence`/`general_aggregate` limit back to the right label
row for a given vendor without guessing. `vendor_policies.each_occurrence_limit`/
`general_aggregate_limit` *are* updated precisely, by `policy_type`, and are
the correct source of truth for carried limits going forward. See
[Known compromises](#known-compromises).

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
it isn't a uniqueness constraint); and (Phase 3) `apply_policy_renewal()` -
superseding the old policy and inserting the new one is genuinely atomic (a
CHECK-constraint-violating renewal rolls back the whole call, old row included),
a `read_only` member and an owner acting outside their own company are both
refused by RLS exactly as a direct write would be (the function is not
`security definer`), and `anon` cannot execute it at all. The harness stubs a
minimal `storage.objects`/`storage.buckets` schema (PGlite has no `storage`
schema of its own) — see `supabase/tests/harness.ts`.

`src/tests/upload-tokens.test.ts` and `src/tests/email.test.ts` separately cover
the pure token/email logic (no database needed for those).
`src/tests/insurance-extraction-schema.test.ts` covers the extraction schema and
the carrier-string-to-enum normalizer; `src/tests/document-extraction.test.ts`
covers the extraction provider itself against a mocked Anthropic client (no API
key or network call needed) - not-configured, high/low confidence routing,
markdown-fence stripping, invalid JSON, a thrown API error, and a model refusal.
`src/tests/compliance-engine.test.ts` covers `matchExtractedPolicy()` and
`computeComplianceItems()` - every match outcome, the deliberate `null` !=
`"compliant"` handling, and that `lienWaiver` is never touched by a
certificate-of-insurance extraction.

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
- **`vendor_coverage_limits` co-locates required and carried amounts.** Required
  belongs on a per-company `compliance_requirements` table; carried belongs on
  `vendor_policies`. They are together only because the current `CoverageLimit`
  contract pairs them.
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
- **`email_outbox` is one table**, not the `email_events` / `email_deliveries`
  split a fuller design calls for. One row per send attempt answers "did this go
  out" for Phase 1; split it once delivery-webhook data (opened/clicked/bounced)
  needs its own lifecycle.
- **No token revocation or resend UI.** `vendor_upload_requests.status` already
  has `cancelled`, and a new request can simply be created, but there is no
  admin control to cancel an outstanding one yet.
- **`db-types.ts` is hand-written**, and the client is intentionally not
  parameterised with it. Run
  `supabase gen types typescript --project-id <ref> > src/data/db-types.ts`, then
  add the generic back to `VendorClearClient` and drop the casts in
  `supabaseRepository.ts`.
- **`vendor_coverage_limits.carried_amount` is not kept in sync with
  `vendor_policies`.** A successful auto-renewal updates
  `vendor_policies.each_occurrence_limit`/`general_aggregate_limit` precisely,
  but the free-text `label` on `vendor_coverage_limits` (what the existing
  Coverage Limits UI reads) has no fixed vocabulary tying it to a
  `policy_type`, so there is no reliable way to auto-update it without
  guessing which label row a given extracted limit belongs to. Split
  `required_amount` onto a real `compliance_requirements` table and read
  `carried_amount` live from `vendor_policies` instead of storing it
  redundantly - see the `vendor_coverage_limits` compromise above, which this
  sharpens now that one side of the pair (`vendor_policies`) is a live,
  auto-updated source of truth and the other (`vendor_coverage_limits`) isn't.
- **No vendor-facing notification when a document needs review or was
  auto-applied.** `email_outbox`/`emailSender.ts`/`emailTemplates.ts` already
  exist from Phase 1 - this is a small, well-understood addition, deliberately
  left out of this pass to keep the matching/auto-update/recompute core
  properly tested on its own.

## What is still not built

Phases 0-3 give vendors and policies a real, tenant-scoped home; close the
outbound half of the loop (request → email → magic link → upload → visible in the
compliance queue); turn an uploaded certificate into structured,
confidence-scored JSON; and, when a deterministic match says it's safe, apply
that JSON to `vendor_policies` and roll the compliance rail forward
automatically. What's not built yet:

- **Matching against what a client actually *requires*, not just what changed.**
  The Phase 3 engine answers "is this a clean renewal of what was already on
  file" - it does not yet check the result against a client's stated
  requirements (a specific limit, additional-insured, a waiver). That
  determination needs the `compliance_requirements` table flagged in
  [Known compromises](#known-compromises); today `vendor_coverage_limits`
  holds required amounts but nothing compares them against what a policy
  actually carries.
- **A review-queue UI.** `needs_review` documents only show up as
  `compliance_queue_items` rows in `'in-review'` state on the existing admin
  screen - there is no screen yet for looking at `parsed_data`,
  `review_reason`, or approving/rejecting a match by hand.
- **Vendor notifications.** Nothing emails a vendor when their document was
  auto-approved or needs one more thing - see
  [Known compromises](#known-compromises).
- **The 90/60/30/14/7-day reminder schedule and next-renewal scheduling.**
  Needs a scheduling mechanism (`pg_cron` is available on the linked project
  but not yet enabled) this phase deliberately didn't reach for without its
  own dedicated pass.
- **Hardening (Phase 4).** Audit log, an automated (not just manually-invoked)
  retry queue, email bounce handling, malware/file-content checks beyond
  mime-type and size, upload-request cancellation UI, admin review tools.

Nothing here claims otherwise: a `processed` extraction that fails
`matchExtractedPolicy()` for even one coverage type on the certificate leaves
`vendor_policies` and `vendor_compliance_items` completely untouched for the
whole document, and `vendor_documents.review_reason` says why.
