# Action Truth Inventory

**Scope:** visible, user-initiated dashboard and auth actions in `src/`, audited against
`origin/main` at `d5f91c6` on 2026-09-15. This is a static code audit, not evidence that a
hosted environment, email provider, or Supabase migration is deployed.

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
| App navigation | Sidebar, mobile navigation, back links, vendor/detail links | `live` | Client-side routing only; does not claim a data mutation. |
| Staff/customer selector | Change visible console | `demo-preview` | A view toggle only; it is explicitly not an authorization boundary. |
| Session | Sign out | `live` | Supabase sign-out is called outside preview mode. |

## Customer operations

| Surface | Action | Status | Evidence / truthful behavior |
| --- | --- | --- |
| Vendor roster | Search and compliance filters | `live` | Local filtering of repository results; no mutation claim. |
| Vendor roster | Add vendor | `live` | `supabaseRepository.createVendor()` inserts a vendor and re-reads seeded compliance rows. Preview calls the in-memory repository and says so. |
| Vendor detail → Contacts | Add contact, edit, link existing, unlink, change role (operational / broker / secondary) | `live` | `src/workflows/vendorContacts.ts` on the request-scoped client; RLS (`can_write_company`) and the cross-company triggers decide. Adding a known email links the existing contact instead of duplicating it (`contacts_company_email_unique`). Read-only roles see no controls. Audited by `record_contact_audit()`. (2026-09-22) |
| Vendor detail → Contacts | Mark do-not-email / clear suppression | `live` | Inserts/deletes `suppressed_recipients` (reason `manual`); bounce/complaint suppressions are shown as "Hard bounce" / "Spam complaint". Clearing asks for confirmation. Audited. |
| Vendor detail | Request documents | `live` | `sendRequest()` → `prepare_contact_request()`. The composer lists exactly who will be emailed and who is excluded before sending; suppressed contacts cannot be ticked, and the server re-derives recipients, rejects ids not linked to this vendor/company, excludes suppressed addresses, and mints a fresh token. Replaces the old single-recipient "Request updated certificate" (`createUploadRequest()`, deleted). |
| Vendor detail | Resend request | `live` | Reopens the composer with that request's recipients, editable; sends a new request with a new token and cancels the old link if unused. |
| Vendor detail → Compliance cases | View deficiencies (required vs submitted values, status, first detected, latest evaluation, escalation level) | `live` | Reads `compliance_cases` / deficiencies / evaluation runs through the request-scoped client; no success claim beyond what the rows say. (2026-09-22) |
| Vendor detail / project detail | Request correction on a deficiency | `live` | Opens the suppression-safe composer on `sendRequest(purpose: "correction")`: explicit recipients, suppressed contacts untickable, server re-derives recipients and records the correction purpose; calls `request_deficiency_correction()` to start the 3/7/14-day clock. No send is claimed without per-recipient outcomes. (2026-09-22) |
| Vendor detail / project detail | Approve exception (owner / risk manager only) | `live` | Calls `approve_compliance_exception()` with an explicit remaining-risk acknowledgement; the button is refused until the acknowledgement is ticked and dates are valid. The internal note is **not** persisted separately (no column) — see Known compromises in `supabase/README.md`. (2026-09-22) |
| Vendor detail / project detail | "Mark compliant" shortcut | intentionally absent | Compliance changes only through sufficient evidence (`apply_evaluation_result()`) or an approved exception; the UI offers no generic override. (2026-09-22) |
| Vendor detail | Communication history | `live` | Per request: date, type, recipient, role, sent / delivered / bounced / complained / failed, excluded-suppressed, upload received. |
| Upload request | Copy upload link | `live` | Copies the generated link; the visible link remains selectable if clipboard access is denied. |
| Upload request | Cancel open request ("Cancel link" in history) | `live` | Calls the cancellation workflow and refreshes the history. |
| Overview | Request documents | `live` | Links to the vendor record's request composer (recipients are confirmed there); no longer sends directly. |
| Vendor upload portal | Upload document | `live` | Validates the token and invokes the upload workflow. |
| Reports | View project rollup | `live` | Reads `company_report_rows` from the configured backend. |
| Reports | Export CSV | `disabled` | No download/export implementation exists. Live UI says “CSV export is not available”; preview says no file was generated. |
| Settings | Change requirement defaults, limits, reminder recipient | `unfinished` | No settings persistence model or server operation exists. Live controls are disabled and say settings are not available; preview keeps its explicit non-persistence notice. |
| Tasks | Change visible priority filter | `live` | Local presentation filter only. |
| Help | Expand FAQ answers | `live` | Local disclosure action only. |
| Team | View team, change role, remove, transfer ownership | `live` | Reads/writes `company_members` via owner-checked security-definer RPCs (`change_company_member_role`, `remove_company_member`, `transfer_company_ownership`); a statement-level trigger blocks leaving a company with no active owner. |
| Team | Invite, view, resend and revoke invitations | `live` | Owner-only. `inviteCompanyMember`/`listCompanyInvitations`/`resendCompanyInvitation`/`revokeCompanyInvitation` call `company_invitations` and its security-definer RPCs; only genuinely pending invitations show resend/revoke. |
| Team | Accept an invitation (`/accept-invite/$token`) | `live` | Public route previews the invitation without a session (generic copy for an invalid/unknown token), then requires the signed-in account's email to match the invitation before calling `accept_company_invitation`. |

## Platform administration

| Surface | Action | Status | Evidence / truthful behavior |
| --- | --- | --- |
| Admin queue | Open a linked document review | `live` | Available only for a backend-backed queue item with a document ID. |
| Document review | Open original document, reprocess, approve, reject | `live` | Calls the document-review/upload workflows; approval has an explicit confirmation step. |
| Admin queue | Review an item without a linked document | `disabled` | The UI explains that no document is available to review. |
| Activation codes | Create, list and withdraw a code | `unfinished` | The admin screen and its security-definer functions are written and covered by `supabase/tests/activation-codes.test.ts`, but the table they use is the pending migration above; until it is applied the hosted database has no `activation_codes`. |
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
asserts that Settings, Reports, Access management, vendor creation, and report errors do not show
demo language. It also requires unavailable production actions to be disabled with explicit labels.

## Handoff / remaining work

- Add Playwright and the `e2e/smoke.spec.ts` / `e2e/role-flows.spec.ts` browser harness in the
  dependency-owner lane. The package is not currently installed, so adding it here would create an
  avoidable lockfile conflict with Engineer A's dependency ownership.
- Replace the three `disabled`/`unfinished` capabilities with real, scoped backend workflows before
  a broad go-live. Until then, they must remain explicit rather than success-looking no-ops.
