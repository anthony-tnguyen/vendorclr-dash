# Gated business signup via per-company invite codes

Date: 2026-09-15

## Problem

`/signup` ([SignupPage](../../../src/features/auth/AuthPages.tsx)) is open self-serve
signup: anyone can create an account, and the `handle_new_user` trigger
([identity_and_tenancy.sql](../../../supabase/migrations/20260901000100_identity_and_tenancy.sql))
auto-provisions a company and makes them its owner. There is no gate today —
this is a genuine security/access-control gap, not a toggle.

Goal: restrict business signup so a new company account can only be created
with a valid, admin-issued invite code.

## Non-goals

- Not gating staff/teammate invites into an _existing_ company. That's the
  demo-only "Invite teammate" button on [AccessPage](../../../src/features/admin/AccessPage.tsx),
  which is unimplemented today and, if built later, needs its own mechanism
  (joining a company vs. creating one) — out of scope here.
- Not building code expiry configurability, resend/regenerate, or bulk
  invite import. Fixed 14-day expiry, one code per invite, admin revokes and
  recreates if needed.

## Design

### Enforcement approach

Enforced server-side in the existing `handle_new_user` trigger on
`auth.users` (AFTER INSERT). The signup form sends `invite_code` in
`options.data` alongside `full_name` (no longer `company_name` — see below).
The trigger validates the code and, if invalid, raises an exception that
aborts the entire `auth.users` insert — `supabase.auth.signUp()` fails and no
account is created. This is the same transactional pattern the trigger
already uses, requires no new Supabase project configuration (no Auth Hooks),
and can't be bypassed by calling the Supabase JS/REST API directly instead of
the form, because the gate lives in the database, not the client.

Rejected alternatives:

- **Supabase "Before User Created" Auth Hook** — the purpose-built mechanism
  for this, but requires configuring a hook in the Supabase project
  (dashboard/config), new infra this repo doesn't otherwise use.
- **Edge-function pre-check before signUp()** — nicer UX (fail before typing
  a password) but not a gate on its own, since a client could skip straight
  to `auth.signUp()`. Would have to sit on top of the trigger anyway, so
  deferred as a pure UX enhancement, not part of this design.

### Data model

New table `public.signup_invites`:

| column       | type        | notes                                               |
| ------------ | ----------- | --------------------------------------------------- |
| id           | uuid pk     | `gen_random_uuid()`                                 |
| code         | text unique | generated, uppercase hex, human-shareable           |
| email        | text        | normalized lowercase; only this address may redeem  |
| company_name | text        | used to create the company on redemption            |
| status       | text        | `pending` \| `used` \| `revoked`, default `pending` |
| expires_at   | timestamptz | `created_at + 14 days`, set at insert time          |
| created_by   | uuid        | references `platform_admins.user_id`                |
| created_at   | timestamptz | default `now()`                                     |
| used_at      | timestamptz | null until redeemed                                 |
| used_by      | uuid        | references `auth.users.id`, null until redeemed     |

Code generation: `upper(replace(gen_random_uuid()::text, '-', ''))` truncated
to 10 hex characters, generated in a `BEFORE INSERT` trigger on
`signup_invites` if not supplied. Core Postgres only — no `pgcrypto`,
consistent with this migration set's stated avoidance of that extension. A
unique constraint plus a short retry loop in the generator handles the
(very unlikely) collision case.

RLS: `signup_invites` is admin-only, gated by the existing
`is_platform_admin()` helper — same pattern as the `platform_admins` table
itself. No policy grants any access to `anon` or non-admin `authenticated`
users.

### Admin UI

New page `InvitesPage` at `/dashboard/admin/invites`, added to `routes` and
`adminNav` in [router.tsx](../../../src/app/router.tsx) after "Access",
wrapped in `AdminGuard` like every other admin page.

- Create form: company name, email. Expiry is fixed at 14 days, not exposed
  as a field in v1.
- Table: company, email, code, status, expires, created — with a **Revoke**
  action on `pending` rows (sets `status = 'revoked'`).
- The code is shown once in the table, in plain text, for the admin to copy
  or read aloud. No separate reveal step — the table is already admin-only.

`DashboardRepository` ([contracts.ts](../../../src/data/contracts.ts)) gains:

```ts
listSignupInvites(): Promise<SignupInvite[]>;
createSignupInvite(draft: { companyName: string; email: string }): Promise<SignupInvite>;
revokeSignupInvite(id: string): Promise<void>;
```

- `demoRepository.ts`: fake data + no-op mutations, matching the existing
  demo pattern for `listAccessGrants`.
- `supabaseRepository.ts`: `createSignupInvite` calls a
  `create_signup_invite(company_name, email)` RPC (keeps code generation and
  defaults server-side rather than relying on client-supplied insert
  defaults); `listSignupInvites` is a plain `select` on `signup_invites`;
  `revokeSignupInvite` is a plain `update`.
- Per the established Supabase gotcha in this project: `create_signup_invite`
  gets `revoke execute ... from public` **and** explicit
  `revoke ... from anon, authenticated` before granting execute only to
  `authenticated` (the function checks `is_platform_admin()` internally;
  nothing is granted to `anon`).

### Signup form changes

[AuthPages.tsx](../../../src/features/auth/AuthPages.tsx) `SignupPage`:

- Removes the free-text "Company name" field. Company name is no longer
  client-supplied — it comes from the invite record the trigger looks up, so
  a redeemed code can't be used to claim a different company name than the
  admin intended.
- Adds an "Invite code" field.
- Remaining fields: Invite code, Your name, Work email, Password.
- `options.data` becomes `{ invite_code, full_name }`.
- Server errors (invalid/expired/wrong-email code) flow through the existing
  `signUpError.message` → `Messages` error-display path unchanged — no new
  client-side error handling needed.

### Trigger logic (`handle_new_user`, extended)

```
requested_code := raw_user_meta_data ->> 'invite_code'

invite := select * from signup_invites
            where code = upper(btrim(requested_code))
            and status = 'pending'
            for update   -- locks the row; closes the double-redeem race

if invite is null
   or invite.expires_at < now()
   or lower(invite.email) <> lower(new.email)
then raise exception 'Invalid or expired invite code.'  -- aborts the whole insert

-- valid:
insert into profiles (...)                                   -- unchanged
insert into companies (name) values (invite.company_name)    -- name now from the invite
insert into company_members (..., role = 'owner')            -- unchanged
update signup_invites set status = 'used', used_at = now(), used_by = new.id
  where id = invite.id
```

Edge cases:

- **Double redemption race**: `for update` locks the invite row for the
  duration of the transaction; a second concurrent signup attempting the
  same code waits for the lock, then sees `status = 'used'` and fails.
- **Expired vs. wrong-email vs. revoked**: all three return the identical
  generic error message (`"Invalid or expired invite code."`) so a leaked
  code can't be probed to determine why it failed or who it was meant for.
- **Revoked codes**: just `status = 'revoked'`, caught by the same
  `status = 'pending'` filter as any other non-pending state.

## Testing

- Migration: exercise the trigger directly against valid, expired, wrong-
  email, revoked, and already-used invites; confirm the double-redeem race
  fails closed under `for update`.
- `supabaseRepository.ts` / `demoRepository.ts`: unit tests for the three new
  repository methods, following the existing test patterns for
  `listAccessGrants`/`listLeads`.
- `InvitesPage`: component test following the existing admin-page pattern in
  [page-behaviors.test.tsx](../../../src/tests/page-behaviors.test.tsx) (loading/error/empty
  states, create + revoke actions).
- `SignupPage`: update existing signup tests for the new field set
  (invite code instead of company name) and add a case asserting a
  `signUpError.message` from a rejected trigger surfaces in the UI.
- New route added to the admin route list in
  [routes.test.tsx](../../../src/tests/routes.test.tsx).
