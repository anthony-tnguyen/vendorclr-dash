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
| Signup | Create account with an invite code | `live` | Supabase signup carries the invite code for server-side redemption. |
| Password reset | Send reset link | `live` | Supabase password-reset API is called when configured. |
| App navigation | Sidebar, mobile navigation, back links, vendor/detail links | `live` | Client-side routing only; does not claim a data mutation. |
| Staff/customer selector | Change visible console | `demo-preview` | A view toggle only; it is explicitly not an authorization boundary. |
| Session | Sign out | `live` | Supabase sign-out is called outside preview mode. |

## Customer operations

| Surface | Action | Status | Evidence / truthful behavior |
| --- | --- | --- |
| Vendor roster | Search and compliance filters | `live` | Local filtering of repository results; no mutation claim. |
| Vendor roster | Add vendor | `live` | `supabaseRepository.createVendor()` inserts a vendor and re-reads seeded compliance rows. Preview calls the in-memory repository and says so. |
| Vendor detail | Request updated certificate | `live` | Creates a tokenized upload request when the backend is configured. |
| Upload request | Copy upload link | `live` | Copies the generated link; the visible link remains selectable if clipboard access is denied. |
| Upload request | Cancel open request | `live` | Calls the cancellation workflow and refreshes the list. |
| Vendor upload portal | Upload document | `live` | Validates the token and invokes the upload workflow. |
| Reports | View project rollup | `live` | Reads `company_report_rows` from the configured backend. |
| Reports | Export CSV | `disabled` | No download/export implementation exists. Live UI says “CSV export is not available”; preview says no file was generated. |
| Settings | Change requirement defaults, limits, reminder recipient | `unfinished` | No settings persistence model or server operation exists. Live controls are disabled and say settings are not available; preview keeps its explicit non-persistence notice. |
| Tasks | Change visible priority filter | `live` | Local presentation filter only. |
| Help | Expand FAQ answers | `live` | Local disclosure action only. |

## Platform administration

| Surface | Action | Status | Evidence / truthful behavior |
| --- | --- | --- |
| Admin queue | Open a linked document review | `live` | Available only for a backend-backed queue item with a document ID. |
| Document review | Open original document, reprocess, approve, reject | `live` | Calls the document-review/upload workflows; approval has an explicit confirmation step. |
| Admin queue | Review an item without a linked document | `disabled` | The UI explains that no document is available to review. |
| Signup invites | Create an admin-issued company signup invite | `live` | Repository operations persist and revoke server-backed invites when configured. |
| Access management | View access grants | `live` | Reads company memberships and profiles from the configured backend. |
| Access management | Invite teammate | `disabled` | No membership invitation backend workflow exists. Live UI says teammate invitations are not available; preview says no invitation was created or emailed. |
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
