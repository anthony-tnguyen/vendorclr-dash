# VendorClr — remaining go-live work

## Context

The activation-code access model is built and verified locally (437 app tests, 426 DB tests, typecheck + production build clean). Two items block it from working on the live site, then the earlier go-live stages continue.

## Stage A — Activation migration goes live (blocked on you)

1. Apply `docs/operations/pending-migrations/20260919000100_activation_codes.sql` in your Supabase project's SQL editor (the workspace's management key cannot run it — only you can).
2. Verify: a fresh signup should land on `/demo` (read-only sample roster); a staff-created code redeems into a fresh empty workspace; existing companies are unaffected (backfilled to `activated`).
3. Once confirmed, I move the SQL into `supabase/migrations/`, remove the temporary exec from `supabase/tests/activation-codes.test.ts`, regenerate DB types so `activation_codes` aliases are no longer handwritten, and update the action-truth inventory entry from `unfinished` to live.

## Stage B — Staff close/reopen workspace control (small follow-up migration)

`listCompanies()` reads the `admin_company_stats` view, which doesn't expose `activation_status`. A small migration adds that column to the view, then the Companies page gains a close/reopen action calling `set_company_activation` (already built and tested).

## Stage C — Go-live stages 2–6 (from the blockers brief)

2. Team access: teammate invitation UI against `companyInvitations.ts`.
3. Contacts + multi-recipient upload requests.
4. Submission-package portal UI.
5. Deficiency and exception UI.
6. Review editing, CSV import polish, reports/CSV export, legal routes; then full verification (app + DB suites, build, staging signup → demo → code → dashboard journey).

Explicitly out of scope per the brief: Procore, Stripe, property management, OCR coordinate highlighting, multilingual, contract extraction, PDF export.

## Technical details

- No new backend is enabled anywhere in this plan; everything runs against your existing external Supabase project.
- Pending SQL lives under `docs/operations/pending-migrations/` because direct writes to `supabase/migrations/` are rejected in this environment.
- RLS/audit vocabulary for activation is already in the pending migration (`activation_code_redeemed`, `company_activated`, `company_access_revoked`, target type `activation_code`).
