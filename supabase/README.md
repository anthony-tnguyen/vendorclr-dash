# Phase 0 — auth, tenancy and the vendor/policy model

This is the backend the dashboard was missing. Before this, the app had no users, no
accounts, and no link between a vendor and whoever owns it.

## What the migrations create

| Migration | Contents |
|---|---|
| `20260901000100_identity_and_tenancy.sql` | `profiles`, `companies`, `company_members`, `platform_admins`, the RLS helper functions, signup provisioning |
| `20260901000200_vendor_domain.sql` | `vendors`, `vendor_policies`, `vendor_compliance_items`, `vendor_coverage_limits` |
| `20260901000300_tasks_queue_leads_and_views.sql` | `tasks`, `compliance_queue_items`, `leads`, and the report/admin views |

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
members; staff read-everything/write-nothing; and `seed.sql` including idempotency.

**What it does not cover:** `auth.users` and `auth.uid()` in the harness are stubs
matching the shape the migrations depend on. Real GoTrue behavior — email
confirmation, production JWT claim contents, `service_role` specifics — still needs
a real `supabase db reset` before shipping.

## Known Phase 0 compromises

Deliberate, and worth revisiting before Phase 1 grows on top of them:

- **`vendors.trade` stores display strings** (`'Mechanical / HVAC'`) to match the
  `VendorTrade` union 1:1 with no mapping layer. Move to a lookup table before
  trade filtering or localisation.
- **`vendor_coverage_limits` co-locates required and carried amounts.** Required
  belongs on a per-company `compliance_requirements` table; carried belongs on
  `vendor_policies`. They are together only because the current `CoverageLimit`
  contract pairs them.
- **`compliance_queue_items` is a real table.** Phase 2 should derive it from
  `document_processing_jobs` and drop it.
- **One company per user.** `resolveCompanyId()` takes the oldest membership.
  Multi-company users need a company switcher in the session context first.
- **Data loads in the browser only.** `getSupabaseClient()` throws during SSR by
  design. Server-rendered private data needs a request-scoped client reading the
  session cookie — `createBrowserClient` already stores it in a cookie so that
  step does not require re-authentication.
- **`db-types.ts` is hand-written**, and the client is intentionally not
  parameterised with it. Run
  `supabase gen types typescript --project-id <ref> > src/data/db-types.ts`, then
  add the generic back to `VendorClearClient` and drop the casts in
  `supabaseRepository.ts`.

## What is still not built

Phase 0 gives vendors and policies a real, tenant-scoped home. The renewal loop on
top of it — vendor upload requests and magic links, the vendor-facing upload portal,
private document storage, text extraction with OCR fallback, the insurance parser,
validation and matching, the compliance engine, and the reminder schedule — is
Phase 1 onward. Nothing here claims otherwise: in live mode the app footer says
document upload, extraction and renewal email are not built yet.
