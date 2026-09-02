# Backend: auth, tenancy, the vendor/policy model, and the renewal loop

Three phases so far:

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

## What the migrations create

| Migration | Contents |
|---|---|
| `20260901000100_identity_and_tenancy.sql` | `profiles`, `companies`, `company_members`, `platform_admins`, the RLS helper functions, signup provisioning |
| `20260901000200_vendor_domain.sql` | `vendors`, `vendor_policies`, `vendor_compliance_items`, `vendor_coverage_limits` |
| `20260901000300_tasks_queue_leads_and_views.sql` | `tasks`, `compliance_queue_items`, `leads`, and the report/admin views |
| `20260901000400_vendor_upload_requests_and_documents.sql` | `vendor_upload_requests`, `vendor_documents`, `email_outbox`, the private `vendor-documents` storage bucket |
| `20260902000100_security_and_performance_hardening.sql` | Fixes discovered by applying 1-4 to a real project and running Supabase's advisor — see [Security model](#security-model) |
| `20260902000200_document_extraction.sql` | Adds `parsed_data`, `extraction_confidence`, `duplicate_of_document_id` to `vendor_documents` |

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
`::uuid` cast on the folder-segment policy; and (Phase 2) the extraction columns'
constraints (confidence between 0 and 1), that `duplicate_of_document_id` sets to
null rather than erroring when its target is deleted, and that two documents for
the same vendor are allowed to share a `sha256` (duplicate detection reads that,
it isn't a uniqueness constraint). The harness stubs a minimal
`storage.objects`/`storage.buckets` schema (PGlite has no `storage` schema of its
own) — see `supabase/tests/harness.ts`.

`src/tests/upload-tokens.test.ts` and `src/tests/email.test.ts` separately cover
the pure token/email logic (no database needed for those).
`src/tests/insurance-extraction-schema.test.ts` covers the extraction schema and
the carrier-string-to-enum normalizer; `src/tests/document-extraction.test.ts`
covers the extraction provider itself against a mocked Anthropic client (no API
key or network call needed) - not-configured, high/low confidence routing,
markdown-fence stripping, invalid JSON, a thrown API error, and a model refusal.

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
  needs its own lifecycle in Phase 3.
- **No token revocation or resend UI.** `vendor_upload_requests.status` already
  has `cancelled`, and a new request can simply be created, but there is no
  admin control to cancel an outstanding one yet.
- **`db-types.ts` is hand-written**, and the client is intentionally not
  parameterised with it. Run
  `supabase gen types typescript --project-id <ref> > src/data/db-types.ts`, then
  add the generic back to `VendorClearClient` and drop the casts in
  `supabaseRepository.ts`.

## What is still not built

Phases 0-2 give vendors and policies a real, tenant-scoped home, close the
outbound half of the loop (request → email → magic link → upload → visible in the
compliance queue), and turn an uploaded certificate into structured,
confidence-scored JSON. What's not built yet:

- **The compliance engine (Phase 3).** Matching extracted policy data against
  what a client actually requires, updating `vendor_policies` and
  `vendor_compliance_items` from a `processed` extraction, an actual review
  queue UI for `needs_review` documents (they currently only show up as
  `compliance_queue_items` rows in `'in-review'` state - there is no screen yet
  for looking at `parsed_data` itself), and the 90/60/30/14/7-day reminder
  schedule.
- **Hardening (Phase 4).** Audit log, an automated (not just manually-invoked)
  retry queue, email bounce handling, malware/file-content checks beyond
  mime-type and size, upload-request cancellation UI, admin review tools.

Nothing here claims otherwise: `vendor_documents.parsed_data` and
`extraction_confidence` are populated, but `vendor_policies` and
`vendor_compliance_items` are never written by the upload or extraction path -
a `processed` extraction result sits next to the vendor's actual policy
records, unconnected to them, until Phase 3.
