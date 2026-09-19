# Roadmap

## Activation-code access model (approved plan: `.lovable/plan/activation-code-access-model-2026-09-18.md`)

- [x] PR 1 — Migration authored, applied to the live project
      (`fzrcowwonezflydicpbd`), and smoke-tested end to end:
      `supabase/migrations/20260918000200_activation_codes.sql`
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
- [x] Final verification — typecheck clean; app tests 440 passed; database tests
      420 passed (`bun run db:verify`); production build succeeded; lint 0 errors
      (9 pre-existing shadcn/ui warnings); browser suite (`bun run e2e`) green:
      9 passed, 8 skipped (the credential-gated account journeys, which need
      E2E_* credentials set). The staging sign-up → demo → code → dashboard
      journey is part of those skipped specs until credentials are provided.

## Carried from the earlier approved plan

- [ ] Stage 2 — Teammate access UI + `/accept-invite/$token`
- [ ] Stage 3 — Vendor/broker contacts + multi-recipient document requests
- [ ] Stage 4 — Vendor upload portal rebuilt on submission packages
- [ ] Stage 5 — Deficiency + exception UI
- [ ] Stage 6 — Review editing, CSV import UI, reports/CSV export, `/terms` + `/privacy`

## Waiting on the user

- [x] Apply `supabase/migrations/20260918000200_activation_codes.sql` to the
      hosted project - applied via the Supabase MCP connector and verified live:
      backfill left 0 companies in `demo`, `activation_codes` has exactly the
      one staff-only `activation_codes_select` policy, the audit vocabulary
      constraints picked up the new actions/target type, and a seeded
      issue → redeem → verify → clean-up round trip produced the right
      company/membership/audit rows and the two anti-probing error paths
      ("already has a workspace", "not recognised" for both an unknown code
      and someone else's code).
- [ ] Settings audit-history check: confirm a change-history entry appears after
      saving in Dashboard → Settings
- [ ] Confirm the customer-facing wording "activation code"
- [x] Sign-in gate: signed-out visitors on any console page are sent to `/login`
      with the page they asked for remembered; `/` routes to sign-in when signed
      out and to the dashboard otherwise; sample-data mode stays ungated.
