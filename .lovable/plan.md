# Send signed-out visitors to the sign-in screen

## Why it behaves this way today

Two separate things are happening, and neither one is a bug in the sign-in screen itself:

1. **There is no sign-in gate.** Opening the site lands on `/` which immediately forwards to `/dashboard`. Nothing checks whether anyone is signed in, so a signed-out visitor gets the console shell instead of the sign-in form. Nothing on the page links to sign in or sign up either.
2. **This preview has no connection settings.** The file holding the database address and public key is missing from the workspace again, so the whole app falls back to sample-data mode: the sign-in form openly says it authenticates no one, and every screen shows demo content. That is why the dashboard looks like the demo.

The redirect to the demo screen that does exist only fires for a *signed-in* account whose workspace has not been activated yet — it never applies to a signed-out visitor.

## What to change

- **Gate the console.** When real connection settings are present and no one is signed in, send visitors from any `/dashboard` screen to the sign-in screen, remembering where they were headed so they land back there after signing in. While the session is still being determined, keep showing the existing loading state rather than flashing either screen.
- **Keep sample-data mode untouched.** With no connection settings, the app stays the browsable demo it is today — gating it would leave the preview with a sign-in form that cannot sign anyone in.
- **Add a real entry point.** Route `/` to the sign-in screen for signed-out visitors and to `/dashboard` for signed-in ones, instead of unconditionally forwarding to `/dashboard`. The sign-in screen keeps its link to create an account.
- **Return after sign-in.** Sign-in honours the remembered destination when present, otherwise `/dashboard` as today.
- **Restore the connection settings file** so the preview stops running as sample data and this behaviour can actually be seen. The values are already known from earlier.

## Technical notes

- The gate belongs in `AppShell`, alongside the existing activation gate, so every dashboard page inherits it: when `mode === "live" && status === "anonymous"`, `navigate({ to: "/login", search: { redirect: location.href }, replace: true })`. Order matters — the signed-out check runs before the activation check.
- `src/routes/index.tsx` currently throws an unconditional `redirect({ to: "/dashboard" })` in `beforeLoad`. Session state lives in React context, not router context, so the decision moves into a small component that reads `useSession()` and redirects once status resolves.
- `src/routes/login.tsx` gains an optional `redirect` search param, validated as a same-origin relative path; `LoginPage` navigates there on success and also bounces an already-signed-in visitor away.
- Tests: extend `src/tests/routes.test.tsx` / `page-behaviors.test.tsx` with a signed-out live-mode case asserting the redirect to `/login`, and a sample-data case asserting the dashboard still renders.

## Out of scope

No change to activation codes, the `/demo` screen, or the pending database migration.
