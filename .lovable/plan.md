# Turn off demo mode and test the Stripe connection

## Why demo mode is on

The whole app flips to demo mode whenever two browser-side settings are missing:
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Right now the project-root `.env`
file that carried them is gone (only `.env.example`, `.env.staging`, and
`.env.production` exist), so the preview is showing the demo repository and the
"Demo mode — checkout is not available" banner on /checkout.

No backend change is involved — this project already talks to your own external
Supabase projects through those settings; nothing new is being enabled.

## Which backend to test against

- **Staging** (`ukbgjriqszthtgwxyirr…`): its three Stripe-related functions
  (`create-checkout`, `stripe-webhook`, `billing-portal`) are all deployed and
  reachable, and Stripe sandbox prices exist for the three plans. Sandbox keys
  live here, so paying with test card `4242…` works and nothing is charged.
- **Production** (`fzrcowwonezflydicpbd…`): all three functions return 404 —
  they are **not deployed** to production yet. Production testing requires
  deploying them plus live prices/keys, which can only be run from your side.

Plan: test on staging.

## Steps

1. **Restore local preview settings** — create `.env` as a copy of `.env.staging`
   (staging Supabase URL, staging publishable key, `VITE_APP_URL`). Restart the
   preview so the build picks the settings up.
2. **Verify demo mode is off** — the sign-in page shows the real login form with
   no demo disclaimer, and /checkout shows the three plan cards enabled with no
   demo-mode banner.
3. **Run the checkout test** (documented in `docs/operations/stripe-checkout.md`):
   - Sign up a fresh account on staging (open sign-up, no workspace yet).
   - On /checkout, choose a plan. This calls the deployed `create-checkout`
     function on the staging project.
   - If Stripe secrets are not yet set on that project, the function answers
     `503 "Checkout is not configured."` — set `STRIPE_SECRET_KEY` (sandbox
     `sk_test_…`/`rk_test_…`) and `APP_URL` (the staging origin) in the Supabase
     dashboard under Edge Functions → Secrets. This step is on your side: the
     management key for CLI access was rejected earlier.
   - Once configured: pay with card `4242 4242 4242 4242`, any future expiry/CVC,
     and fill the "Company name" field.
4. **Confirm the round trip** — after payment, the webhook should create the
   company (activation_status=activated, service_status=onboarding), the owner
   membership, an onboarding row, audit rows, and a processed `stripe_events` row;
   the buyer lands on /onboarding.
5. **Set `STRIPE_WEBHOOK_SECRET`** (from a Stripe webhook endpoint pointing at
   `https://ukbgjriqszthtgwxyirr.supabase.co/functions/v1/stripe-webhook`) so
   subscription updates and cancellations sync too.

## What stays unchanged

- No database or engine changes, no schema edits.
- The production project's function deployment remains a separate follow-up.
