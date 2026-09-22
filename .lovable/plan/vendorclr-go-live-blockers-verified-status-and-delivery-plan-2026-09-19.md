# VendorClr go-live blockers — verified status and delivery plan

## What I checked in the repo today

- `bun run format:check` fails on **13 files only**: 12 injected skill docs under `.workspace/skills/` and one archived plan file. No application source is misformatted.
- Customer screens that exist: overview, vendors, vendor detail, tasks, reports, settings, help, demo. **No projects, requirement-profile, contacts, accept-invite, CSV-import, terms or privacy screens exist.**
- Backends that already exist and must be reused, not rebuilt: project, requirement, contact, submission, compliance-case and report repositories; communications, submission-package, vendor-import, report-export, invitation, upload-abuse workflows.
- ~~Both request paths are still present: legacy `createUploadRequest()` and multi-recipient `sendRequest()`; the vendor-facing action still uses the legacy one.~~ **2026-09-22:** `createUploadRequest()` is deleted; vendor detail, resend and CSV-import dispatch all use `sendRequest()`.
- Reports page (89 lines) and Access page (92 lines) are both still the small "not available" placeholders.
- Vendor upload portal is still the single-file experience (239 lines).
- Document review page is substantial (455 lines) — needs auditing, not rebuilding.

## Status of each blocker

| Item | Status |
| --- | --- |
| P0-1 formatting | 🟡 Partial — only non-source files fail |
| P0-1 E2E vs new auth model | 🔴 Open — tests still assume anonymous dashboard access |
| P0-2 Projects UI | 🔴 Open (backend complete) |
| P0-3 Requirement profiles UI | 🔴 Open (backend complete) |
| P0-4 Teammate access UI | 🔴 Open (backend complete) |
| P0-5 `/accept-invite/$token` | 🔴 Open |
| P0-6 Contacts / broker UI | ✅ Done 2026-09-22 — Contacts panel + communication history on vendor detail |
| P0-7 Retire legacy request path | ✅ Done 2026-09-22 — legacy path deleted; every send path checks suppression. 🟡 Live only after the migration is applied and the 3 mail-sending Edge Functions are redeployed |
| P0-8 Package upload portal | 🔴 Open (backend complete) |
| P0-9 Turnstile client UI | 🔴 Open; keys are ⚪ external |
| P0-10 Deficiency UI | 🔴 Open (backend complete) |
| P0-11 Exception UI | 🔴 Open (backend complete) |
| P0-12 Reviewer editing | 🟡 Audit + tests, likely complete |
| P0-13 Reports CSV export UI | 🔴 Open (backend complete) |
| P1-1 CSV import UI | 🔴 Open (backend complete) |
| P0-14 Terms / Privacy routes | 🔴 Open |
| P0-15…P0-19, P1-2, branch protection | ⚪ External — staging deploy, provider keys, Vault, backups, restore drill, alert destination all need accounts/credentials I cannot provision |

## Delivery plan

Each numbered item is one focused change set, verified before the next starts.

1. **CI + auth E2E repair.** Add `.workspace/` and `.lovable/plan/` to `.prettierignore` so `format:check` covers real source only. Rewrite `e2e/role-flows.spec.ts` and `e2e/smoke.spec.ts` around the real access model: signed-out → sign-in; signed-in unactivated → demo console; activated member → dashboard; admin access; mobile navigation; vendor search/filter; explicit permission-denied. Authentication is not weakened to satisfy old tests.
2. **Projects + requirement profiles.** Projects list (name, number, status, location, active vendors, compliance summary, profile) with create/edit/archive; project detail with certificate holder, profile, overrides, assignments, per-assignment compliance, assign/deactivate vendor, trade, contract value, risk tier. Requirement-profile management: list, create, rename, edit rules, archive, company default, attach to project or assignment, project overrides, with a guard that no assignment can end with zero effective requirements. One vendor, many assignments; existing precedence preserved; Settings untouched.
3. **Team invitations + acceptance.** Real Access page (members, pending invites, invite with role, resend, revoke, change role, remove, ownership transfer, role-based visibility) on the existing RPCs, plus `/accept-invite/$token` covering valid, expired, revoked, already accepted, wrong account, auth required and success — using the backend's generic errors so tokens cannot be probed.
4. **Contacts + suppression-safe requests.** Vendor detail gains operational, broker and secondary contacts (agency, email, phone, role, bounce state) with add/edit/link/unlink/role, brokers reusable across vendors. Move the document-request action onto `sendRequest()`: explicit recipient selection, suppression enforced, fresh token per request, history, delivery state, resend with recipient editing. Retire or harden the legacy path so no send path bypasses suppression, with the five named tests.
5. **Submission-package portal + Turnstile UI.** Rebuild the vendor portal on the package workflow: request context, real checklist, multi-file upload with per-file document type, progress, remove before finalize, summary, finalize through the async queue, confirmation with reference ID and processing state, and single-document deficiency replacement. Render the Turnstile challenge only when the existing server risk threshold asks for it; document the key provisioning as an owner action.
6. **Deficiencies + exceptions.** Plain-language deficiency list with required vs submitted values, status, dates, escalation, related package; open, request correction to chosen recipients, delivery and resubmission history, auto-resolve on satisfying evidence, one case across cycles. Exception approval for authorized roles only: reason, remaining-risk acknowledgement, effective/expiry dates, notes, optional attachment, with approver and status shown. No "mark compliant" shortcut.
7. **Reports, CSV import, legal.** Wire the real server-side exporter for every listed report with permission checks, audit event, sanitized filename and a real download; remove the stale copy. Build the CSV import flow (upload → preview → validate → row/column errors → create-vs-match → confirm → execute → results) on the existing idempotent backend. Add `/terms` and `/privacy` with clearly marked "Pending legal/product approval" sections, linked from sign-in, sign-up, the portal and the app footer.
8. **Reviewer-edit audit.** Verify `DocumentReviewPage` against the requirement list, add tests proving reviewer edits create a revision and never overwrite the model extraction, and mark it complete rather than rebuilding it.
9. **Documentation truth sweep.** Re-audit every visible action and rewrite `docs/product/action-truth-inventory.md` from the code, not the old table. Update the 2026-09-18 blocker plan into a status document with ✅/🟡/🔴/⚪ per item, plus `environment-matrix.md`, `backup-restore.md`, `release-process.md`, `provider-setup.md`, `supabase/README.md` (closing the compromises that are genuinely closed) and `roadmap.md`. Create `docs/operations/go-live-checklist.md` with only evidence-backed ticks.

## Verification

Each change set ends with typecheck, lint, format check, app tests, `db:verify`, production build and the Playwright suite. New browser journeys cover authentication, company setup, vendor submission, the correction loop, exceptions, team invites and reporting export.

## What I cannot finish in this repository

These need accounts, credentials or infrastructure I do not control. I will leave the code fail-safe and document the exact owner action for each:

- Staging Cloudflare deployment, staging Supabase URL/keys/secrets and the GitHub staging environment (P0-15).
- Staging Resend, Anthropic, VirusTotal, Sentry and Turnstile credentials (P0-16, P0-9).
- Staging Supabase Vault `project_url` / `service_role_key` and verification of the four cron jobs (P0-17).
- Recurring encrypted production backups — the workflow ships disabled until a secure storage destination and credentials exist (P0-18) — and the restore drill that depends on it (P0-19).
- A real alert destination for `VITE_ALERT_WEBHOOK_URL` (P1-2).
- GitHub branch protection, subject to the repository plan (external blocker).

Also out of scope per the brief: Procore, Stripe, property management, OCR coordinate highlighting, multilingual, contract extraction, PDF export.

## Sequencing note

This is a large program. I'll ship the items in order so you can review each in the live app, and report status after each rather than at the very end.
