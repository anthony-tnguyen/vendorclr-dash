# Activation-code access model

## What changes for you

- **Sign up with just an email and password.** No code needed. You land in a **read-only demo console** showing the sample vendor roster, clearly labelled as a demo with nothing saved.
- **When you pay, we issue you an activation code.** You type it into your own dashboard; a real, empty workspace is created for your company and the console unlocks for you and your teammates.
- **Staff get a code console.** Issue codes, see who redeemed them, and revoke access — a revoked account sees a clear "access ended" screen instead of the real console.

```text
sign up (no code)  ->  account with no company  ->  /demo  read-only sample console + code box
enter paid code    ->  company + owner seat + activated  ->  /dashboard  real console
staff revoke       ->  activation_status = revoked  ->  /demo  "access ended" + how to restore
```

## Current state (verified this session)

- `src/features/auth/AuthPages.tsx` — the sign-up form has a **required Invite code** field; the code also has to match the sign-up email.
- `supabase/migrations/20260915000100_gated_signup_invites.sql` — `handle_new_user()` creates a company and an owner seat **only** when a valid pending invite code is supplied. No code, no company.
- `src/data/supabaseRepository.ts` — `resolveCompanyId()` throws _"Signed-in user belongs to no company…"_, so a codeless account currently sees an **error state** on the dashboard, not a demo.
- `supabase/migrations/20260901000100_identity_and_tenancy.sql` — `companies` already has `plan` (`Field`, `Program`, `Enterprise`) and `subscription_renews_on`, so codes can carry a plan without a new enum.
- `src/components/shell/AppShell.tsx` is the chrome every dashboard page renders through — one place to enforce access.
- `src/domain/featureFlags.ts` exists but no screen reads it; the admin **Signup invites** page (`src/features/admin/InvitesPage.tsx`, `InviteForm.tsx`, `src/routes/dashboard.admin.invites.tsx`) manages the code table that sign-up is about to stop using.

## Stage 1 — Database (one migration, applied by you)

New file `supabase/migrations/20260919000100_activation_codes.sql`:

- `companies.activation_status` (`demo` | `activated` | `revoked`, default `demo`), `activated_at`, `activated_by`, `revoked_at`.
- **Backfill in the same file:** every existing company is set to `activated`. Without this line your current customers lose access the moment the migration runs.
- New table `public.activation_codes`: `code` (unique, 10-char unambiguous alphabet, generated server-side like today's invite codes), `email` (lowercase, locks who may redeem), `company_name`, `plan`, `note`, `status` (`pending` | `used` | `revoked`), `created_by`, `used_at`, `used_by`, `redeemed_company_id`, timestamps. `signup_invites` is **left untouched** — no drop, history preserved.
- `GRANT` statements in the same file, then `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, then policies: platform admins may `SELECT`; **no** direct insert/update/delete for any role — writes go through functions only.
- `SECURITY DEFINER` functions, each with an explicit role check inside (the pattern `set_company_feature_flag()` already uses):
  - `create_activation_code(email, company_name, plan, note)` — platform staff only.
  - `revoke_activation_code(id)` — platform staff only; `pending` → `revoked`.
  - `redeem_activation_code(code)` — signed-in customer. Requires the code to be `pending` **and** the caller's email to match. Creates the company (name + plan from the code, `activation_status = 'activated'`), inserts the owner seat, sets `subscription_renews_on` if the code carries one, marks the code `used`. Every failure — unknown code, wrong email, already used, revoked — returns the **same** message so the form can't be used to probe which codes exist.
  - `set_company_activation(company, status)` — platform staff only; `revoked` shows the access-ended screen, `activated` restores it. Data is never deleted by revoking.
- Widen `audit_log_action_check` / `audit_log_target_type_check` for `activation_code_created`, `activation_code_revoked`, `activation_code_redeemed`, `company_access_revoked`, `company_activated` and target types `activation_code` / `company`. Audit rows are written from inside the definer functions, since `audit_log` has no insert policy for signed-in users.
- I'll hand you the SQL plus a short verification query set (columns, backfill count, function grants, one redemption smoke test) and won't call anything done until you report the results.

## Stage 2 — Open sign-up and the demo screen

- `src/features/auth/AuthPages.tsx`: drop the invite-code field and its hints; sign-up becomes email, name, password.
- `src/app/App.tsx`: the identity read already pulls the caller's company; extend it to include `activation_status` and expose `access: "demo" | "activated" | "revoked"` plus a staff pass-through.
- New route `/demo` and `src/features/demo/DemoScreen.tsx`: the sample roster (Halstead Builders, Corbett Structural Steel, their COIs) rendered **read-only** with the existing `ComplianceRail`, `ComplianceBadge` and `ComplianceMatrix`, a plain "Demo console — this is sample data, not your account, and nothing here is saved" banner, a short list of what activation unlocks, and the **activation code form** with loading, success, error and already-activated states. No add-vendor, request-documents or upload buttons anywhere on it.
- Access enforcement in `AppShell` (one place, covers customer and admin pages): a signed-in account that is not activated and not staff is sent to `/demo`; an activated account visiting `/demo` is sent to `/dashboard`. While the session is still resolving, nothing renders but the loading state. In the preview (no backend configured) `/demo` renders the same sample screen, so the screen is exercisable without a database.
- The **access-ended** variant of the same screen: `activation_status = 'revoked'` → "Your VendorClr access has ended", what that means for your data (retained, not deleted), and how to restore it.

## Stage 3 — Staff activation console

- `/dashboard/admin/activation-codes` replacing the Signup invites nav slot: list of codes (email, company, plan, status, created, redeemed company), create form with validation and the generated code shown once with copy, revoke with confirmation, and loading / empty / error / denied states — built on the same `AsyncState` components and `AdminGuard` the other admin pages use.
- `src/features/admin/CompaniesPage.tsx`: activation column plus **Revoke access** / **Restore access** for platform staff.

## Stage 4 — Retire the invite-code surface

The old code path has to go, or it becomes a second, contradicting way in. Files to update or remove: `src/app/router.tsx` (nav + `routes`), `src/routes/dashboard.admin.invites.tsx`, `src/features/admin/InvitesPage.tsx`, `src/features/admin/InviteForm.tsx`, `src/data/contracts.ts` (`DashboardRepository` invite methods), both repository implementations, `src/data/demoRepository.ts`, plus the call sites in `src/tests/page-behaviors.test.tsx`, `src/tests/routes.test.tsx`, `src/workflows/companyInvitations.ts` docs, `scripts/lib/companyScopedTables.ts` and `supabase/README.md`. `src/data/db-types.ts` regenerates after the migration.

## Stage 5 — Tests

- Database (`supabase/tests/activation-codes.test.ts`): redemption creates company + owner seat + activation in one call; wrong email, unknown code, used code and revoked code all fail with the identical message; a revoked code can never be redeemed; non-staff cannot create codes; existing companies come back `activated`; audit rows exist.
- App: sign-up form has no code field; `/demo` renders the sample roster with **no** write affordances; an unactivated account is kept off `/dashboard`; the code form's loading / success / error states; the access-ended screen.
- Browser journey on staging: sign up → demo → enter code → real console → add a vendor.

## What I need from you

1. Apply the Stage 1 SQL and report the verification output (this workspace cannot write to your database).
2. Tell me the code wording you want customers to see — "activation code" is my assumption throughout.
3. Nothing else is blocked: no Stripe, no billing integration, no new provider accounts. Codes are issued by staff after payment, matching the brief's instruction not to build speculative billing.

## Sequencing

- **PR 1:** migration file + open sign-up + `/demo` screen + access enforcement. Nothing breaks before the SQL is applied: new accounts simply see the demo, existing accounts are backfilled to activated.
- **PR 2:** staff activation console + companies-page revoke/restore + retire the signup-invite surface.
- **PR 3:** database and app tests, production copy audit of the touched screens, full suites, build, staging journey.

Each PR reports summary, schema impact, security and RLS considerations, user-visible changes, tests, migration/deployment steps and remaining gaps. The earlier approved plan's Stage 2 (teammate access) still stands and comes after this, since it touches the same sign-up and access surfaces.
