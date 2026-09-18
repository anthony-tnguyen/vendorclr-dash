# Roadmap

## Activation-code access model (approved plan: `.lovable/plan/activation-code-access-model-2026-09-18.md`)

- [x] PR 1 — Migration authored and verified against a real Postgres:
      `docs/operations/pending-migrations/20260918000200_activation_codes.sql`
      (activation columns + backfill, `activation_codes`, security-definer functions,
      audit widening). Open sign-up, the `/demo` screen and the access gate in
      `AppShell` are in place.
- [x] PR 2 — Staff activation console at `/dashboard/admin/activation`. The
      signup-invite surface is retired end to end: pages, route, sidebar entry,
      repository operations and types.
- [ ] PR 2b — Staff control to close / reopen a workspace from the Companies page.
      **Blocker:** `listCompanies()` reads the `admin_company_stats` view, which does
      not carry `activation_status`. Showing a truthful button needs a second pending
      migration (alter the view) first.
- [x] PR 3 — `supabase/tests/activation-codes.test.ts` (11 checks) plus app coverage
      for the demo screen and the console, and a copy audit of the touched screens
      (`docs/product/action-truth-inventory.md` re-audited for sign-up, the demo
      console and activation codes).
- [ ] Final verification — full suites and production build on the merged branch, and
      the staging journey sign-up → demo → code → dashboard.

## Carried from the earlier approved plan

- [ ] Stage 2 — Teammate access UI + `/accept-invite/$token`
- [ ] Stage 3 — Vendor/broker contacts + multi-recipient document requests
- [ ] Stage 4 — Vendor upload portal rebuilt on submission packages
- [ ] Stage 5 — Deficiency + exception UI
- [ ] Stage 6 — Review editing, CSV import UI, reports/CSV export, `/terms` + `/privacy`

## Waiting on the user

- [ ] Apply `docs/operations/pending-migrations/20260918000200_activation_codes.sql`
      to the hosted project and report the verification output - the steps are in
      `docs/operations/pending-migrations/README.md`
- [ ] Settings audit-history check: confirm a change-history entry appears after
      saving in Dashboard → Settings
- [ ] Confirm the customer-facing wording "activation code"
