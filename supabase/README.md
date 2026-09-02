# Backend: auth, tenancy, the vendor/policy model, and the renewal loop

Two phases so far:

- **Phase 0** — auth, tenancy, and a real vendor/policy model. Before this, the app
  had no users, no accounts, and no link between a vendor and whoever owns it.
- **Phase 1** — the outbound half of the renewal workflow: an admin requests an
  updated certificate, the vendor gets a magic link with no account required,
  uploads a file, and it lands in private storage and the existing admin
  Compliance Queue screen.

## What the migrations create

| Migration | Contents |
|---|---|
| `20260901000100_identity_and_tenancy.sql` | `profiles`, `companies`, `company_members`, `platform_admins`, the RLS helper functions, signup provisioning |
| `20260901000200_vendor_domain.sql` | `vendors`, `vendor_policies`, `vendor_compliance_items`, `vendor_coverage_limits` |
| `20260901000300_tasks_queue_leads_and_views.sql` | `tasks`, `compliance_queue_items`, `leads`, and the report/admin views |
| `20260901000400_vendor_upload_requests_and_documents.sql` | `vendor_upload_requests`, `vendor_documents`, `email_outbox`, the private `vendor-documents` storage bucket |

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
See `.env.example`.

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
members; staff read-everything/write-nothing; `seed.sql` including idempotency; and
(Phase 1) `vendor_upload_requests`/`vendor_documents`/`email_outbox` tenancy, the
25MB file-size check at the database level, and the `vendor-documents` storage
bucket's RLS — including a regression test for the regex guard in front of the
`::uuid` cast on the folder-segment policy. The harness stubs a minimal
`storage.objects`/`storage.buckets` schema (PGlite has no `storage` schema of its
own) — see `supabase/tests/harness.ts`.

`src/tests/upload-tokens.test.ts` and `src/tests/email.test.ts` separately cover
the pure token/email logic (no database needed for those).

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
  `uploadDocumentForToken()` as well as staff. Phase 2 should derive it from
  `document_processing_jobs` and drop it.
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

Phases 0 and 1 give vendors and policies a real, tenant-scoped home and close the
outbound half of the loop: request → email → magic link → upload → visible in the
compliance queue. What's not built yet:

- **Document intelligence (Phase 2).** Text extraction with OCR fallback, the
  insurance JSON schema, carrier/policy/date extraction, confidence scoring,
  duplicate detection via `vendor_documents.sha256` (the column exists; nothing
  reads it yet).
- **The compliance engine (Phase 3).** Automatic policy matching, updating
  `vendor_compliance_items` from extracted data, the review queue for low-confidence
  extractions, and the 90/60/30/14/7-day reminder schedule.
- **Hardening (Phase 4).** Audit log, retry queues, email bounce handling,
  malware/file-content checks beyond mime-type and size, upload-request
  cancellation UI, admin review tools.

Nothing here claims otherwise: `vendor_documents.processing_status` starts and
stays at `'uploaded'` — nothing moves it to `'processed'` yet — and
`vendor_compliance_items` is never written by the upload path.
