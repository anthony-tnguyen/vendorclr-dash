# Teammate Invitations Design

## Goal

Ship the customer-facing UI for teammate invitations on top of the existing `company_invitations` backend, RPCs, and `src/workflows/companyInvitations.ts` workflow layer — without rebuilding any of that layer, and without inventing a second role model or a second authorization boundary.

## Existing-system constraints

- `company_invitations` (table, RLS, 4 RPCs: `create_company_invitation`, `resend_company_invitation`, `revoke_company_invitation`, `accept_company_invitation`) is the only persistence model for invitations. It is not modified by this work.
- `src/workflows/companyInvitations.ts` already exports every function the UI needs: `inviteCompanyMember`, `listCompanyInvitations`, `resendCompanyInvitation`, `revokeCompanyInvitation`, `acceptCompanyInvitation`, `previewCompanyInvitationByToken`, plus `CompanyMemberRole`/`CompanyInvitation` types and `INVITATION_TTL_DAYS`. This UI calls those functions; it does not call Supabase directly and does not re-implement token hashing, expiry, or email sending.
- Authorization stays server-side: owner-only create/resend/revoke is enforced inside the RPCs, and the invited-email match on accept is enforced inside `accept_company_invitation` by comparing `auth.users.email` server-side. Client-side checks in this UI (owner gate on buttons, email-match messaging on the accept page) are presentation only, matching the existing pattern documented in `src/app/App.tsx` ("the actual boundary is RLS").
- `accept_company_invitation` is granted to `authenticated` only, never `anon` — an unauthenticated visitor cannot accept; they must sign in/sign up first. `previewCompanyInvitationByToken` is the only anonymous-safe read (service-role, returns `null` uniformly for invalid/expired/revoked/accepted tokens — no valid/invalid oracle).
- Role vocabulary is `CompanyMemberRole = "owner" | "risk_manager" | "project_engineer" | "read_only"`, already defined in `companyInvitations.ts` and mirrored by a DB check constraint. The invite form reuses `TeamPage.tsx`'s existing `ROLE_OPTIONS` (value/label/blurb) rather than redefining role copy.
- Invitation links are built by `acceptInvitationUrl(token)` in `companyInvitations.ts`, which already reads `VITE_APP_URL` (falling back to `http://localhost:3000` only when unset) and points at `/accept-invite/:token`. This UI does not build links itself — it only needs the route to exist at that path.

## Routes and navigation

- New file-based route `src/routes/accept-invite.$token.tsx` (TanStack Router, dynamic segment matching the `vendor-upload.$token.tsx` convention), rendering `AcceptInvitePage` from `src/features/team/AcceptInvitePage.tsx`. Public route: no `AppShell`, no dashboard nav entry (it's an emailed magic-link destination, not a navigable page).
- Add `acceptInvite: "/accept-invite/$token"` to the `routes` map in `src/app/router.tsx` for consistency with other route constants, even though nothing links to it from in-app nav.
- No changes to `/dashboard/team`'s route registration — the new sections render inside the existing `TeamPage.tsx`.

## Team page: invite + pending invitations

`TeamPage.tsx` stays the entry point but delegates the two new sections to sibling components so the file doesn't keep growing as one block:

- `src/features/team/InviteMemberForm.tsx` — email input, role `<select>` (from `ROLE_OPTIONS`), submit button. Rendered only when the current user's `companyRole === "owner"` (same gate already used for role-change/remove/transfer controls). On submit, calls `inviteCompanyMember`; shows inline success ("Invitation sent to {email}") or error state without a page reload. Invalidates the pending-invitations query key on success.
- `src/features/team/PendingInvitationsTable.tsx` — reads `listCompanyInvitations` via TanStack Query (key `["team-invitations", companyId]`), renders one row per invitation with email, invited role (via the same `roleLabel()` helper), inviter (already resolved to email by the workflow), created date, expiration, and status. Resend/revoke buttons render only for rows whose _computed_ status (the lazy-expiry status the workflow already returns, not a raw DB column) is genuinely `pending` — expired, revoked, and accepted rows are display-only. Resend and revoke call `resendCompanyInvitation`/`revokeCompanyInvitation` and invalidate the same query key. Owner-only, mirroring the invite form's gate; non-owners see no pending-invitations section at all, consistent with how `TeamPage.tsx` already hides mutation affordances from non-owners.

Both components are wired into `TeamPage.tsx` directly below the existing active-members table, sharing its existing `companyId`/`companyRole` context rather than re-fetching session state.

## Accept-invite route experience

`AcceptInvitePage` (`src/features/team/AcceptInvitePage.tsx`) drives all states from two inputs: the token param and the current `useSession()` value.

1. On mount, load `previewCompanyInvitationByToken(token)`. A `null` result renders one generic "This invitation link isn't valid" state — covering invalid, expired, revoked, and already-accepted tokens identically at the preview stage, so an anonymous visitor gets no signal about which case applies (no token-enumeration oracle). Once more invitation detail is available post-auth (see step 3), expired/revoked/already-accepted get their own distinguishable copy, because at that point the visitor already holds a token tied to a real, identifiable invitation and there's no new information being leaked by being specific.
2. If `session.status !== "authenticated"`: show "Sign in with **{invite.email}** to join {invite.companyName}" (email/company name come from the preview, which is designed to be shown pre-auth) with a link to `/login?redirect=/accept-invite/${token}`, reusing `login.tsx`'s existing same-origin-validated `redirect` search param. This is how invitation state survives the auth round-trip — no extra client storage needed, the token is already in the URL the user returns to.
3. If authenticated: compare `session.email` (new field, see below) to the invite's email case-insensitively.
   - Match → show an explicit "Accept invitation" action (not auto-accept on load, so a signed-in user who followed a stale tab/bookmark doesn't join a company without an affirmative click). On click, call `acceptCompanyInvitation`; on success, navigate to `/dashboard` with a brief confirmation. On failure (invitation became stale between preview and accept — expired/revoked/accepted/replayed), show the specific corresponding state using the RPC's error, not a generic failure.
   - Mismatch → "This invitation was sent to {invite.email}, but you're signed in as {session.email}" with a sign-out-and-switch-account affordance. Do not reveal anything about the mismatched account beyond the fact that it doesn't match.
4. Success state confirms acceptance and role, then routes into `/dashboard` (the newly joined workspace).

## Session email

Add `email: string | null` to the live-mode identity shape (`LiveIdentity`/`Session`) in `src/app/App.tsx`, populated from the same `supabase.auth.getSession()`/`onAuthStateChange` call that already runs there, rather than a separate ad hoc `auth.getUser()` call inside the new route. Demo-mode sessions get `email: null`.

## Legacy surface removal

`src/features/admin/AccessPage.tsx`'s "Invite teammate" control is permanently disabled today and unrelated to `company_invitations` (it uses the old demo/live repository abstraction). Once the real flow ships on `/dashboard/team`, this control is removed along with its now-dead repository plumbing (`listAccessGrants`/invite stub in `src/data/contracts.ts` and its demo/supabase repository implementations, if nothing else references them). `src/tests/production-action-truth.test.tsx`'s assertion about this control is updated to match. `docs/product/action-truth-inventory.md`'s "Access management / Invite teammate" row is corrected to describe the real Team-page flow instead of the removed disabled stub.

## Authorization and failure behavior

- Invite/resend/revoke buttons render only for owners; this is presentation, not enforcement — the RPCs independently reject non-owner callers.
- The accept route never trusts client-supplied email/role/company data for the actual join — `acceptCompanyInvitation` is a thin wrapper over `accept_company_invitation`, which does its own server-side email comparison against `auth.users`.
- Preview responses and error states are uniformly generic where the token itself is the only credential (pre-auth), and only become specific once the caller has demonstrated authorized context (post-auth, or already holds detail from a successful preview) — this line is deliberate, not incidental, and should not be adjusted to make error copy "more helpful" without re-checking the no-oracle requirement above.
- No client-supplied token, email, role, or invitation ID is trusted beyond RPC/RLS validation.

## Tests and verification

Frontend unit tests cover: owner sees and can submit the invite form, non-owner does not see invite/pending sections, successful invite shows success state and appears in the pending list, invite error surfaces inline, pending list renders correct status per row and only shows resend/revoke on genuinely pending rows, resend and revoke call through and refresh the list.

Accept-route tests cover: unauthenticated visitor sees sign-in prompt with preserved redirect, correct-email authenticated user can accept and lands in dashboard with the invited role, wrong-email authenticated user is rejected with a safe message and no extra detail, expired invite shows expired state, revoked invite shows revoked state, already-accepted invite shows already-used state, invalid token shows the generic state, replay (accepting twice) is rejected, and invalid vs. expired vs. revoked tokens are not distinguishable at the pre-auth preview stage.

E2E (Playwright) adds: owner opens Team → invites a teammate → teammate opens the emailed link → signs in → accepts → teammate appears in the active member list with the selected role.

Documentation: `roadmap.md`'s "Stage 2 — Teammate access UI + /accept-invite/$token" item is checked off; `docs/product/action-truth-inventory.md` is corrected as above. No blocker/status markdown file exists separately from these two, so no third doc needs updating. Teammate access is marked complete only once both creation and acceptance are verified working end-to-end (unit + E2E), not on UI existing alone. Any external email-delivery setup (Resend API key provisioning, domain verification) that remains outside this repo's control is called out separately in the final report, not folded into "done."
