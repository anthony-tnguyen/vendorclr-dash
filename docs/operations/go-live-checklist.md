# Go-live checklist

Re-audited 2026-09-22 against `main` at `d5f8897` plus the pilot-blockers
branch (`pilot-blockers-reports-import-legal`: reports + CSV export, CSV
import UI, reviewer editing, `/terms` + `/privacy`). Every row below was
checked against code, CI, or the live Supabase projects on that date. Nothing
is copied forward from an earlier status document.

| Mark | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| ✅   | Complete - built, tested, and (where it has a backend change) deployed          |
| 🟡   | Partial - works, with a named gap                                               |
| 🔴   | Open - a pilot blocker that engineering can close                               |
| ⚪   | External - needs an account, credential, approval or decision engineering lacks |

**This is not a go-live sign-off.** Pilot readiness is the bottom section;
read it before quoting any single ✅.

## How each row was verified

- **CI:** `gh run list --branch main` - the latest run on `d5f8897` (#62) is
  green, and so are the five before it. One earlier Lovable "Changes" commit
  (`383c20f`) failed and was fixed by #59/#60.
- **Deployed schema:** Supabase `list_migrations` for production
  (`fzrcowwonezflydicpbd`) and staging (`ukbgjriqszthtgwxyirr`). Both have
  every migration on `main` through `20260922130000_email_outbox_company_invitations`.
  The pilot-blockers migration `20260922140000` is **not applied anywhere yet**.
- **Code paths:** read directly (`src/features/**`, `src/workflows/**`).
- **Tests on the pilot-blockers branch:** typecheck clean; lint 0 errors
  (11 pre-existing warnings); format clean; `bun run test` 521 passed;
  `bun run db:verify` 461 passed; production build succeeded; `bun run e2e`
  13 passed, 15 skipped (every signed-in journey - see the E2E row).

## Customer product

| Area                                          | Status | Evidence / gap                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in, sign-up, password reset, access gate | ✅     | Supabase auth; signed-out console routes go to `/login` (`e2e/role-flows.spec.ts` signed-out cases pass).                                                                                                                                                                                                                                                                            |
| Activation-code flow                          | ✅     | `redeem_activation_code()` etc. applied live (`20260918073244_activation_codes`); staff console `/dashboard/admin/activation`; `supabase/tests/activation-codes.test.ts`. Staff close/reopen of a workspace from Companies is still not built (roadmap PR 2b).                                                                                                                       |
| Settings (company default requirements)       | ✅     | `SettingsPage` loads/saves through `requirementSettings.ts` with an audit history. The user-side "change-history entry appears after saving" confirmation in `roadmap.md` is still unticked.                                                                                                                                                                                         |
| Team member management                        | ✅     | Change role / remove / transfer ownership via owner-checked RPCs (#52).                                                                                                                                                                                                                                                                                                              |
| Teammate invitations + `/accept-invite`       | 🟡     | UI shipped (#58) and `company_invitation` emails are recorded in `email_outbox` (`20260922130000`, live). `e2e/team-invite.spec.ts` has never run - no `E2E_OWNER_*`/`E2E_INVITEE_*` accounts.                                                                                                                                                                                       |
| Projects + requirement profiles               | ✅     | Projects list/detail, assignments, resolved requirements, profile create/rename/archive/default (#53/#54); both migrations live.                                                                                                                                                                                                                                                     |
| Vendor contacts + suppression-safe requests   | ✅     | #55; migration + 3 Edge Functions deployed to staging and production 2026-09-22.                                                                                                                                                                                                                                                                                                     |
| Submission-package vendor portal              | 🟡     | #57 + #62 on `main`. Turnstile challenge UI ships but no Turnstile keys exist (⚪ below), so the challenge can't be served.                                                                                                                                                                                                                                                          |
| Deficiencies, correction requests, exceptions | 🟡     | Live UI on the existing RPCs. Exceptions carry a reason and a risk acknowledgement but no internal note: there is no column for one, so the form has no note field (Known compromises in `supabase/README.md`).                                                                                                                                                                      |
| Reports UI (13 assignment-based reports)      | 🟡     | Pilot-blockers branch. Compliance by project/trade, expiring 30/60/90, missing evidence, open deficiencies, active exceptions, unresponsive, bounced, time to compliance, resubmissions, reviewer turnaround. Unit + router tests pass; **not merged, and never run against a real company in a browser** (E2E skipped).                                                             |
| CSV export                                    | 🟡     | Existing server exporter (`exportReport()`), now wired for every report: membership check, sanitized filename, browser download, `report_exported` audit row. Same merge/E2E caveat. PDF export is out of scope.                                                                                                                                                                     |
| Bulk CSV import UI                            | 🟡     | Pilot-blockers branch: upload → preview → validate (row/column/reason) → create-vs-match per project/vendor/assignment → confirm → idempotent execute → results + rejected-rows CSV. Needs migration `20260922140000` applied, because until then `import_vendor_row()` still accepts `read_only` members at the database (the app now refuses them first). Not merged; E2E skipped. |
| Reviewer editing                              | 🟡     | Pilot-blockers branch: field editor → new `reviewer_edit` revision; revision history, reviewer-changes diff, shortfalls, required rejection reason, internal note, review history. Invariant tested in unit, UI and PGlite tests; the DB-level UPDATE block needs `20260922140000` applied. E2E skipped.                                                                             |
| `/terms`, `/privacy`                          | 🟡     | Routes exist and are linked from sign-in, sign-up, the vendor portal and the console sidebar (E2E `legal.spec.ts` passes). Content is factual only; every commitment section says "Pending legal/product approval". Real text is ⚪ below.                                                                                                                                           |

## Engineering pilot blockers still open

| Item                                                       | Status | What closes it                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge the pilot-blockers branch and apply `20260922140000` | 🔴     | Merge, then apply to staging and production and confirm with `list_migrations` (it has not been applied anywhere).                                                                                              |
| Signed-in browser journeys have never run                  | 🔴     | Create `E2E_MEMBER_*`, `E2E_OWNER_*`, `E2E_INVITEE_*`, `E2E_STAFF_*` accounts on staging and set them in CI. 15 specs skip today, including reports, import, reviewer editing, team invite and correction loop. |
| Staging application deployment                             | 🔴     | No staging Cloudflare Worker exists (`environment-matrix.md`), so `staging-smoke.yml` has no `STAGING_URL`.                                                                                                     |
| Workspace close/reopen from Companies                      | 🔴     | Roadmap PR 2b: `admin_company_stats` needs `activation_status` first.                                                                                                                                           |

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

**Not ready for a customer pilot yet.** Every customer-facing screen in the
blocker plan now exists in code, but:

1. The reports, import, reviewer-editing and legal work is on an unmerged
   branch, and its migration is not deployed.
2. No signed-in journey has ever run in a real browser against a real
   database. Everything past the sign-in screen is proven only by unit,
   router-level and PGlite tests.
3. Production document extraction appears unconfigured (Anthropic key), and
   the vendor portal's abuse challenge can't be served (no Turnstile keys).
4. There are no backups on the current Supabase plan.
5. There is no approved legal text.

An internal-tenant pilot (VendorClr staff only, no customer documents) could
start after items 1 and 2. A design-partner pilot also needs items 3 to 5.
