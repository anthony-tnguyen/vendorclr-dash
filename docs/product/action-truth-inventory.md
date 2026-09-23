# Action Truth Inventory

**Scope:** visible, user-initiated dashboard and auth actions in `src/`, re-audited on
2026-09-22 against `main` at `7193d1f` (PR #63 merged: Reports + CSV export, CSV import,
reviewer editing, `/terms` + `/privacy`). The supporting migration `20260922140000` is
applied to staging and production (2026-09-22), so the import write-role and extraction
immutability rules below are DB-backed. This is a code audit. For what is deployed and what
is still blocking a pilot, see `docs/operations/go-live-checklist.md`.

## Classification rules

| Status         | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `live`         | The UI invokes a backend-backed operation when Supabase is configured.         |
| `demo-preview` | Intentionally operates only on the in-memory preview repository.               |
| `disabled`     | The UI names an unavailable workflow and cannot imply it completed.            |
| `unfinished`   | No complete user-safe action exists yet; it must not be exposed as successful. |

## Auth and navigation

| Surface | Action | Status | Evidence / truthful behavior |
| --- | --- | --- |
| Sign in | Sign in | `live` | Calls Supabase password auth when configured; preview clearly says it authenticates nobody. |
| Signup | Create account, no code required | `live` | Supabase signup creates a profile only; the new account then lands on the demo console. |
| Demo console | Browse the sample roster | `demo-preview` | Rendered from the in-memory demo repository, labelled as sample data, with no add/upload/request control to click. |
| Demo console | Enter an activation code | `live` | The screen calls `redeem_activation_code()`; that function and the `activation_codes` table are applied to the hosted database via `supabase/migrations/20260918000200_activation_codes.sql` and verified with a live seeded redemption. |
| Password reset | Send reset link | `live` | Supabase password-reset API is called when configured. |
| Auth screens, vendor portal, console sidebar | Terms / Privacy links → `/terms`, `/privacy` | `live` | Public, signed-out routes. Factual descriptions only; every section that would carry a legal commitment reads "Pending legal/product approval". |
| App navigation | Sidebar, mobile navigation, back links, vendor/detail links | `live` | Client-side routing only; does not claim a data mutation. |
| Staff/customer selector | Change visible console | `demo-preview` | A view toggle only; it is explicitly not an authorization boundary. |
| Session | Sign out | `live` | Supabase sign-out is called outside preview mode. |

## Customer operations

| Surface | Action | Status | Evidence / truthful behavior |
| --- | --- | --- |
| Vendor roster | Search and compliance filters | `live` | Local filtering of repository results; no mutation claim. |
| Vendor roster | Add vendor | `live` | `supabaseRepository.createVendor()` inserts a vendor and re-reads seeded compliance rows. Preview calls the in-memory repository and says so. |
| Vendor roster → Import CSV (`/dashboard/vendors/import`) | Upload, preview, validate, confirm, import; download template / rejected rows | `live` | Parses in the browser, validates with `validateVendorImportRows()` (row/column/reason; create vs. match for project, vendor and assignment; optional upload request), requires an explicit confirmation checkbox, then `executeVendorImport()`: idempotent key per validated file, invalid rows never written, `can_write_company` checked first in the app and enforced at the database by migration `20260922140000` (applied to staging + production 2026-09-22, verified live). Results show processed / created / matched / skipped / rejected / request-send failures. Read-only members and sample-data mode get an explanation instead of the upload control. |
| Projects | Create / edit project, assign vendor, change or terminate assignment, view resolved requirements | `live` | `saveProject()` and direct RLS-checked writes on `projects` / `project_vendor_assignments`; `resolve_assignment_requirements()` for provenance. Archive-guard triggers refuse an archived profile. (#53/#54) |
| Requirement profiles | Create, rename, edit rules, archive, set company default | `live` | RLS-checked writes on `requirement_profiles`; the default swap goes through `set_company_default_requirement_profile()`; the current default can't be archived. |
| Vendor detail → Contacts | Add contact, edit, link existing, unlink, change role (operational / broker / secondary) | `live` | `src/workflows/vendorContacts.ts` on the request-scoped client; RLS (`can_write_company`) and the cross-company triggers decide. Adding a known email links the existing contact instead of duplicating it (`contacts_company_email_unique`). Read-only roles see no controls. Audited by `record_contact_audit()`. (2026-09-22) |
| Vendor detail → Contacts | Mark do-not-email / clear suppression | `live` | Inserts/deletes `suppressed_recipients` (reason `manual`); bounce/complaint suppressions are shown as "Hard bounce" / "Spam complaint". Clearing asks for confirmation. Audited. |
| Vendor detail | Request documents | `live` | `sendRequest()` → `prepare_contact_request()`. The composer lists exactly who will be emailed and who is excluded before sending; suppressed contacts cannot be ticked, and the server re-derives recipients, rejects ids not linked to this vendor/company, excludes suppressed addresses, and mints a fresh token. Replaces the old single-recipient "Request updated certificate" (`createUploadRequest()`, deleted). |
| Vendor detail | Resend request | `live` | Reopens the composer with that request's recipients, editable; sends a new request with a new token and cancels the old link if unused. |
| Vendor detail → Compliance cases | View deficiencies (required vs submitted values, status, first detected, latest evaluation, escalation level) | `live` | Reads `compliance_cases` / deficiencies / evaluation runs through the request-scoped client; no success claim beyond what the rows say. (2026-09-22) |
| Vendor detail / project detail | Request correction on a deficiency | `live` | Opens the suppression-safe composer on `sendRequest(purpose: "correction")`: explicit recipients, suppressed contacts untickable, server re-derives recipients and records the correction purpose; calls `request_deficiency_correction()` to start the 3/7/14-day clock. No send is claimed without per-recipient outcomes. (2026-09-22) |
| Vendor detail / project detail | Approve exception (owner / risk manager only) | `live` | Calls `approve_compliance_exception()` with an explicit remaining-risk acknowledgement; the button is refused until the acknowledgement is ticked and dates are valid. There is no internal-note field: `compliance_exceptions` has no column for one (Known compromises in `supabase/README.md`). |
| Vendor detail / project detail | "Mark compliant" shortcut | intentionally absent | Compliance changes only through sufficient evidence (`apply_evaluation_result()`) or an approved exception; the UI offers no generic override. (2026-09-22) |
| Vendor detail | Communication history | `live` | Per request: date, type, recipient, role, sent / delivered / bounced / complained / failed, excluded-suppressed, upload received. |
| Upload request | Copy upload link | `live` | Copies the generated link; the visible link remains selectable if clipboard access is denied. |
| Upload request | Cancel open request ("Cancel link" in history) | `live` | Calls the cancellation workflow and refreshes the history. |
| Overview | Request documents | `live` | Links to the vendor record's request composer (recipients are confirmed there); no longer sends directly. |
| Vendor upload portal | Submit package | `live` | Validates the token, loads the persisted request checklist, attaches PDF/JPEG/PNG evidence to an open submission package, finalizes it, and queues processing. No VendorClr account is required; receipt confirms receipt, not compliance. |
| Reports | Choose one of 13 reports and view rows | `live` | `getReportRows()` checks active company membership, then calls the existing `reportRepository.ts` read for that report (compliance by project / trade, expiring 30/60/90, missing evidence, open deficiencies, active exceptions, unresponsive vendors, bounced communications, time to compliance, resubmissions, reviewer turnaround). The report is kept in the URL (`?report=`). |
| Reports | Export CSV | `live` | `exportReport()` on the server: membership check, CSV built from the same columns as the table, sanitized filename, `report_exported` audit row; the browser downloads the returned file. Disabled (not faked) when the session has no company. Sample-data mode keeps "Export CSV (demo)", which says nothing was generated. PDF is not offered. |
| Settings | Change company default requirements | `live` | `saveRequirementSettings()` persists the company default profile's rules; the page shows the change history from `loadRequirementAuditHistory()`. A session with no company is told so, with no save control. |
| Tasks | Change visible priority filter | `live` | Local presentation filter only. |
| Help | Expand FAQ answers | `live` | Local disclosure action only. |
| Team | View team, change role, remove, transfer ownership | `live` | Reads/writes `company_members` via owner-checked security-definer RPCs (`change_company_member_role`, `remove_company_member`, `transfer_company_ownership`); a statement-level trigger blocks leaving a company with no active owner. |
| Team | Invite, view, resend and revoke invitations | `live` | Owner-only. `inviteCompanyMember`/`listCompanyInvitations`/`resendCompanyInvitation`/`revokeCompanyInvitation` call `company_invitations` and its security-definer RPCs; only genuinely pending invitations show resend/revoke. |
| Team | Accept an invitation (`/accept-invite/$token`) | `live` | Public route previews the invitation without a session (generic copy for an invalid/unknown token), then requires the signed-in account's email to match the invitation before calling `accept_company_invitation`. |

## Platform administration

| Surface | Action | Status | Evidence / truthful behavior |
| --- | --- | --- |
| Admin queue | Open a linked document review | `live` | Available only for a backend-backed queue item with a document ID. |
| Document review | Open original document, reprocess, approve selected coverage lines | `live` | Calls the document-review/upload workflows; approval has an explicit confirmation step and applies the current extraction revision. |
| Document review | Edit extracted fields → save reviewer revision | `live` | `saveExtractionEdit()` → `record_document_extraction(source 'reviewer_edit')`: a new revision attributed to the reviewer. The model's row is never modified, and migration `20260922140000` (applied to staging + production 2026-09-22, verified live) rejects any UPDATE on `document_extractions`. The page lists every revision, marks the current one, and shows field-level reviewer changes against the model. |
| Document review | Reject | `live` | Needs a rejection reason: the button is disabled until one is entered, and the server schema rejects an empty note. |
| Document review | Internal note, requirement shortfalls, review history | `live` | Internal note is stored in the resolution and audit entry, never sent to the vendor. Shortfalls are the vendor's open deficiencies. History comes from `audit_log` rows for the document and queue item. |
| Admin queue | Review an item without a linked document | `disabled` | The UI explains that no document is available to review. |
| Activation codes | Create, list and withdraw a code | `live` | `create_activation_code()` / `revoke_activation_code()`; migration `20260918073244_activation_codes` is applied on production and staging (verified with `list_migrations` 2026-09-22). |
| Access management | View access grants | `live` | Reads company memberships and profiles from the configured backend. The legacy disabled "Invite teammate" control on this screen was removed; invitations now live on the company's own Team page (see Customer operations above). |
| Companies, leads, overview | Open data and local review detail | `live` | Read paths use the configured repository; review becomes a live route only when a document is linked. |

## Cross-cutting states

| State                      | Status         | Rule                                                                                                |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| Loading                    | `live`         | Names the actual data being loaded and makes no success claim.                                      |
| Backend errors             | `live`         | Use generic recovery copy such as “Could not load report data,” never “demo” in a live environment. |
| Empty data                 | `live`         | Explain the true absence of records; do not suggest an unfinished action is available.              |
| Demo errors and empty data | `demo-preview` | Preview messaging may say demo only when the repository is actually the in-memory preview.          |

## Engineer B regression guard

`src/tests/production-action-truth.test.tsx` renders the affected surfaces as a live session and
asserts that Settings, Reports, Access management and vendor creation show no demo language, and
that Reports' real "Export CSV" stays disabled while the session has no company. The live
Reports, Import and Review flows have their own tests: `src/tests/reports-page.test.tsx`,
`src/tests/vendor-import-page.test.tsx`, `src/tests/document-review-editing.test.tsx`.

## Handoff / remaining work

- Playwright is installed and runs in CI, but every signed-in journey skips because no `E2E_*`
  accounts are configured. The Reports, Import and reviewer-editing specs (`e2e/reports.spec.ts`,
  `e2e/vendor-import.spec.ts`, `e2e/reviewer-editing.spec.ts`) have never run against a real
  database.
- No `disabled` or `unfinished` customer action remains on `main` (#63 merged). The
  only intentionally absent action is "Mark compliant".
