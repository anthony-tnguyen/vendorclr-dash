# Go-live checklist

Re-audited 2026-09-22 against `main` at `7193d1f` (PR #63 merged: reports +
CSV export, CSV import UI, reviewer editing, `/terms` + `/privacy`). The
pilot-blockers migration `20260922140000` was applied to staging and
production on this date and verified at the database level (see below). Every
row below was checked against code, CI, or the live Supabase projects on that
date. Nothing is copied forward from an earlier status document.

> **2026-09-23 update:** the "signed-in browser journeys have never run" row
> below is closed. Five real Supabase Auth users (owner/member/staff/invitee/
> demo) were provisioned directly on staging, wired into CI as `staging`-
> environment secrets, and the full `e2e/**` suite now runs against real
> staging data both locally and in a new `signed-in-e2e` CI job (see
> `.github/workflows/staging-smoke.yml`) - no staging Cloudflare deployment
> needed for this (`playwright.config.ts` boots the built bundle itself via
> local `wrangler dev`). Running it for the first time found and fixed four
> real bugs: a `signIn()` race in the test helper that was masking almost
> everything; `ProjectDetailPage.tsx` rendering "Unknown vendor" on every
> assignment row (a to-one PostgREST embed read as an array); an accessible-
> name defect on the Reports page's report selector; and, most
> significantly, **the document review screen has never actually rendered**
>
> - `dashboard.admin.compliance.tsx` was a bare (non-`.index.tsx`) route
>   sharing its path prefix with the `$queueItemId` detail route, so TanStack
>   Router treated it as that route's parent layout with no `<Outlet />` -
>   clicking into a queue item changed the URL but nothing in the child route
>   ever appeared. See PR #69 for the full detail. Latest verified run: 25
>   passed, 3 skipped (2 because a hand-seeded open-deficiency fixture was
>   already consumed by an earlier successful run - not a defect, a real
>   environment has an ongoing stream of these; 1 because vendor-contacts.spec.ts
>   needs the staging Resend key, still open below).

| Mark | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| ✅   | Complete - built, tested, and (where it has a backend change) deployed          |
| 🟡   | Partial - works, with a named gap                                               |
| 🔴   | Open - a pilot blocker that engineering can close                               |
| ⚪   | External - needs an account, credential, approval or decision engineering lacks |

**This is not a go-live sign-off.** Pilot readiness is the bottom section;
read it before quoting any single ✅.

## How each row was verified

- **CI:** `gh run list --branch main` - the latest run on `7193d1f` (#63) is
  green (`quality`, `db-verify`, `build`, `e2e-smoke`), and so are the runs
  before it.
- **Deployed schema:** Supabase `list_migrations` for production
  (`fzrcowwonezflydicpbd`) and staging (`ukbgjriqszthtgwxyirr`). The
  pilot-blockers migration
  `20260922140000_import_write_role_and_extraction_immutability` is now
  **applied to both** (2026-09-22). Production's recorded history matches
  `supabase/migrations/` one-for-one (56 = 56). Staging's recorded history
  omits six pre-baseline records (`recreate_pg_net_in_extensions_schema`, the
  two index migrations, `fix_get_database_size_bytes_search_path`, and the two
  `construction_core` fixes) that were folded into its 2026-09-17 squashed
  baseline; all six objects were verified present in staging, so its **schema
  is at parity** with production and the repo.
- **DB-level behaviour (2026-09-22):** on staging (live) and on production
  (inside a rolled-back transaction, so no rows persisted), `import_vendor_row()`
  rejected a `read_only` member, a cross-company caller and an anonymous caller
  (all `42501`), and allowed an owner and a platform admin; every direct UPDATE
  on `document_extractions` was rejected (`55000`) while a `reviewer_edit`
  revision INSERT succeeded and left the model row unchanged. Function, trigger
  and grant fingerprints are byte-identical on both projects, and the Supabase
  security advisor reported no new warning.
- **Code paths:** read directly (`src/features/**`, `src/workflows/**`).
- **Tests (main `7193d1f`, re-run this task):** typecheck clean; `bun run test`
  521 passed; `bun run db:verify` 461 passed; production build succeeded;
  `bun run e2e` 13 passed, 15 skipped (every signed-in journey - see the E2E
  row). `bun run lint` and `bun run format:check` pass in CI; run locally they
  also scan `.claude/worktrees/` copies (absent in CI), so ignore those paths
  when reading a local run.

## Customer product

| Area                                          | Status | Evidence / gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in, sign-up, password reset, access gate | ✅     | Supabase auth; signed-out console routes go to `/login` (`e2e/role-flows.spec.ts` signed-out cases pass).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Activation-code flow                          | ✅     | `redeem_activation_code()` etc. applied live (`20260918073244_activation_codes`); staff console `/dashboard/admin/activation`; `supabase/tests/activation-codes.test.ts`. Staff close/reopen of a workspace from Companies is still not built (roadmap PR 2b).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Settings (company default requirements)       | ✅     | `SettingsPage` loads/saves through `requirementSettings.ts` with an audit history. The user-side "change-history entry appears after saving" confirmation in `roadmap.md` is still unticked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Team member management                        | ✅     | Change role / remove / transfer ownership via owner-checked RPCs (#52).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Teammate invitations + `/accept-invite`       | ✅     | UI shipped (#58) and `company_invitation` emails are recorded in `email_outbox` (`20260922130000`, live). `e2e/team-invite.spec.ts` passes against staging as of 2026-09-23 (PR #69): owner invites, invitee signs in and accepts, appears in the member list.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Projects + requirement profiles               | ✅     | Projects list/detail, assignments, resolved requirements, profile create/rename/archive/default (#53/#54); both migrations live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Vendor contacts + suppression-safe requests   | ✅     | #55; migration + 3 Edge Functions deployed to staging and production 2026-09-22.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Submission-package vendor portal              | 🟡     | #57 + #62 on `main`. Turnstile challenge UI ships but no Turnstile keys exist (⚪ below), so the challenge can't be served.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Deficiencies, correction requests, exceptions | 🟡     | Live UI on the existing RPCs. Exceptions carry a reason and a risk acknowledgement but no internal note: there is no column for one, so the form has no note field (Known compromises in `supabase/README.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Reports UI (13 assignment-based reports)      | ✅     | Merged to `main` (#63). Compliance by project/trade, expiring 30/60/90, missing evidence, open deficiencies, active exceptions, unresponsive, bounced, time to compliance, resubmissions, reviewer turnaround. `e2e/reports.spec.ts` passes against staging as of 2026-09-23 (PR #69), including the audit-row check.                                                                                                                                                                                                                                                                                                                                                                                              |
| CSV export                                    | ✅     | Existing server exporter (`exportReport()`), wired for every report: membership check, sanitized filename, browser download, `report_exported` audit row. Exercised live by `e2e/reports.spec.ts` as of 2026-09-23. PDF export is out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Bulk CSV import UI                            | ✅     | Merged to `main` (#63): upload → preview → validate (row/column/reason) → create-vs-match per project/vendor/assignment → confirm → idempotent execute → results + rejected-rows CSV. Migration `20260922140000` is **applied to staging and production** (2026-09-22): `import_vendor_row()` rejects a `read_only` member at the database (verified live), and the app refuses them first. `e2e/vendor-import.spec.ts` passes against staging as of 2026-09-23 - also caught and fixed a real bug where imported vendor names always rendered "Unknown vendor" on the project detail page (PR #69).                                                                                                               |
| Reviewer editing                              | 🟡     | Merged to `main` (#63): field editor → new `reviewer_edit` revision; revision history, reviewer-changes diff, shortfalls, required rejection reason, internal note, review history. Invariant tested in unit, UI and PGlite tests; the DB-level UPDATE block (`20260922140000`) is **deployed to staging and production** (2026-09-22) and verified live. `e2e/reviewer-editing.spec.ts` passes against staging as of 2026-09-23 (PR #69) - also found and fixed a routing bug where this screen never rendered at all (see the note near the top of this document). The approval path is still unexercised (`E2E_ALLOW_REVIEW_APPROVAL` deliberately left unset - approving changes real `vendor_policies` rows). |
| `/terms`, `/privacy`                          | 🟡     | Routes exist and are linked from sign-in, sign-up, the vendor portal and the console sidebar (E2E `legal.spec.ts` passes). Content is factual only; every commitment section says "Pending legal/product approval". Real text is ⚪ below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Engineering pilot blockers still open

| Item                                                           | Status | What closes it                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Merge the pilot-blockers branch and apply `20260922140000`~~ | ✅     | Done 2026-09-22: merged as #63; migration applied to staging and production and confirmed with `list_migrations` plus live DB verification.                                                                                                                           |
| ~~Signed-in browser journeys have never run~~                  | ✅     | Done 2026-09-23 (PR #69): 5 real `E2E_*` accounts provisioned on staging and set in CI; `signed-in-e2e` job runs the full suite. Found and fixed 4 real bugs, including a routing bug that meant the document review screen never rendered - see the note above.      |
| Staging application deployment                                 | 🔴     | No staging Cloudflare Worker exists (`environment-matrix.md`), so `staging-smoke.yml`'s `staging`/`smoke-production-script` jobs still have no `STAGING_URL`. Not a blocker for signed-in E2E (see above), only for a true black-box smoke test of a real deployment. |
| Workspace close/reopen from Companies                          | 🔴     | Roadmap PR 2b: `admin_company_stats` needs `activation_status` first.                                                                                                                                                                                                 |

## External blockers

| Item                                                            | Status | Notes                                                                                                                                                                    |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approved Terms of Service and Privacy Notice                    | ⚪     | Counsel/product must supply text; the pages mark every commitment section pending.                                                                                       |
| Production `ANTHROPIC_API_KEY` for Edge Functions               | ⚪     | At the 2026-09-22 production deploy, `process-document-jobs` reported `notConfigured`. Without it, uploaded documents are not extracted.                                 |
| Staging provider keys (Resend, Anthropic, VirusTotal, Sentry)   | ⚪     | Not separately provisioned (`environment-matrix.md`).                                                                                                                    |
| Turnstile site/secret keys (both environments)                  | ⚪     | No Turnstile account exists.                                                                                                                                             |
| Backups and restore drill                                       | ⚪     | Supabase org is on the Free plan (no automatic backups/PITR). No backup workflow exists in `.github/workflows/`. Runbook: `backup-restore.md`; RPO/RTO pending approval. |
| Alert destination (`VITE_ALERT_WEBHOOK_URL`)                    | ⚪     | No destination provisioned.                                                                                                                                              |
| Branch protection on `main`                                     | ⚪     | `gh api .../branches/main/protection` → "Branch not protected" (private repo; depends on the GitHub plan).                                                               |
| Retention periods, deletion timelines, DPA, SLA, certifications | ⚪     | Legal/product decisions. `data-retention.md` and `account-termination.md` carry strawmen marked pending.                                                                 |

## Pilot readiness (recalculated 2026-09-22)

**Not ready for a customer pilot yet.** The reports, import, reviewer-editing
and legal work is now merged to `main` (#63) and its migration is deployed and
DB-verified on both environments, but:

1. ~~No signed-in journey has ever run in a real browser against a real
   database.~~ Closed 2026-09-23 (PR #69) - see the note near the top of this
   document.
2. Production document extraction appears unconfigured (Anthropic key), and
   the vendor portal's abuse challenge can't be served (no Turnstile keys).
3. There are no backups on the current Supabase plan.
4. There is no approved legal text.

An internal-tenant pilot (VendorClr staff only, no customer documents) could
start now that item 1 is closed. A design-partner pilot also needs items 2
to 4.
