# Roadmap

## Brand asset update

- [ ] Replace all existing wordmark placements with the uploaded logo and verify the uploaded favicon renders.

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

- [x] Stage 2 — Teammate access UI + `/accept-invite/$token` (2026-09-22).
      Invite/pending-invitations UI on `/dashboard/team` (create, resend,
      revoke via `inviteCompanyMember`/`listCompanyInvitations`/
      `resendCompanyInvitation`/`revokeCompanyInvitation`) and the
      `/accept-invite/$token` acceptance route (unauthenticated,
      correct-email, wrong-email, expired, revoked, already-accepted,
      invalid-token and success states), both built entirely on the existing
      `company_invitations` backend and `src/workflows/companyInvitations.ts`
      from an earlier task. `/signup` now honors `?redirect=` so a brand-new
      invitee resumes at the invitation after creating an account. Legacy
      disabled invite control removed from `/dashboard/admin/access`.
- [x] Stage 3 — Vendor/broker contacts + multi-recipient document requests
      (2026-09-22). Contacts panel on vendor detail (name, agency, email,
      phone, role, suppression state; add / edit / link / unlink / change role
      / do-not-email), request composer on `sendRequest()` with an explicit
      recipient preview and suppressed recipients excluded, communication
      history with resend. `createUploadRequest()` deleted; every send path
      (Node and the three mail-sending Edge Functions) checks
      `is_email_suppressed()`. Migration
      `20260922120000_vendor_contacts_request_delivery.sql`.
      **Deployed 2026-09-22** to staging and production (migration, then the
      three Edge Functions), smoke-tested on both.
- [x] Stage 4 — Vendor upload portal rebuilt on submission packages: anonymous
      token links load actual package checklists, support multi-file review and
      finalization, and show queued-processing receipt states. Turnstile code is
      ready but external site/secret keys remain a deployment configuration task.
- [x] Stage 5 — Deficiency + exception UI (done 2026-09-22: case/deficiency
      read view, correction request via `sendRequest(purpose: "correction")` +
      `request_deficiency_correction()`, exception approval via
      `approve_compliance_exception()` with required remaining-risk
      acknowledgement, escalation display from the fixed 3/7/14-day clock).
      Known limitation: `compliance_exceptions` has no internal-note column,
      and the form has no note field (documented in Known compromises).
- [ ] Stage 6 — Review editing, CSV import UI, reports/CSV export, `/terms` + `/privacy`.
      **Merged to `main` as #63 (2026-09-22); the remaining sub-items are the
      signed-in E2E run and approved legal text:**
  - [x] Reports page: 13 assignment-based reports on the existing report reads,
        with the real server-side CSV export (membership check, safe filename,
        browser download, `report_exported` audit row). No PDF.
  - [x] CSV import UI at `/dashboard/vendors/import` on the existing
        preview → validate → execute backend, with create-vs-match for project,
        vendor and assignment, explicit confirmation, idempotent execute,
        results and a rejected-rows CSV.
  - [x] Reviewer editing: field editor saves a new `reviewer_edit` revision;
        revision history, reviewer-changes diff, requirement shortfalls,
        required rejection reason, internal note, review history.
  - [x] `/terms` + `/privacy`: factual content only, every commitment section
        marked "Pending legal/product approval"; linked from sign-in, sign-up,
        the vendor portal and the console sidebar.
  - [x] Merged (#63) and applied migration
        `20260922140000_import_write_role_and_extraction_immutability.sql` to
        staging and production on 2026-09-22 (`import_vendor_row()` →
        `can_write_company()`; `document_extractions` UPDATE blocked), verified
        with `list_migrations` and rolled-back live DB checks.
  - [ ] Run `e2e/reports.spec.ts`, `e2e/vendor-import.spec.ts` and
        `e2e/reviewer-editing.spec.ts` with real `E2E_*` accounts. They skip
        today, like every signed-in spec.
  - [ ] Approved legal text (external).

Current go-live status, verified item by item: `docs/operations/go-live-checklist.md`.

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
- [x] CI + browser-suite repair. The build output is `.output/` (`.output/server/wrangler.json`),
      and `playwright.config.ts` and `ci.yml` use that path. An earlier edit moved them to
      `dist/` on a mistaken assumption; #59 moved them back (re-verified 2026-09-22 by a
      fresh `bun run build`). The rewritten `e2e/smoke.spec.ts` and `e2e/role-flows.spec.ts`
      (desktop + mobile) detect demo vs live builds at runtime and skip the account journeys
      that need `E2E_DEMO_*` / `E2E_MEMBER_*` / `E2E_STAFF_*` credentials. Those credentials
      are still not configured anywhere, so every signed-in journey skips in CI.
