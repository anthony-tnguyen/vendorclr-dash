# Stripe self-checkout

Self-checkout is account-first: a buyer creates a VendorClr account (open
sign-up), picks a self-serve plan, pays through Stripe Checkout, and the webhook
creates their company and drops them into onboarding. Enterprise stays
sales-assisted (activation codes), so it has no Stripe price and no checkout.

## Moving parts

| Piece | Where | Notes |
| --- | --- | --- |
| Products & prices | Stripe (sandbox + live) | One product per plan; monthly price per plan, addressed by **lookup key** `vendorclr_<plan>_monthly`. |
| `create-checkout` | `supabase/functions/create-checkout` | `verify_jwt=true`. Creates a subscription Checkout Session for the signed-in caller. |
| `stripe-webhook` | `supabase/functions/stripe-webhook` | `verify_jwt=false`, Stripe-signature verified. Creates the company + owner + onboarding row; keeps subscription status in sync. |
| `billing-portal` | `supabase/functions/billing-portal` | `verify_jwt=true`. Returns a Stripe billing-portal URL for the caller's company. |
| Schema | `20260929000100_self_checkout_billing_and_onboarding.sql` | `plan_limits`, billing columns + `service_status` on `companies`, `stripe_events`, `company_onboarding`. |

The plan catalogue in the app is `src/domain/billing/plans.ts` — plan ids,
prices, lookup keys, limits. Keep it in sync with the Stripe prices and the
`plan_limits` table by hand.

## Stripe prices (sandbox, created 2026-09-29)

| Plan | Lookup key | Price | Sandbox price id |
| --- | --- | --- | --- |
| Core | `vendorclr_core_monthly` | $149/mo | `price_1UKxdjBJKzz24nkojAHlLDK9` |
| Operations | `vendorclr_operations_monthly` | $349/mo | `price_1UKxdmBJKzz24nkovgZHQ16Q` |
| Scale | `vendorclr_scale_monthly` | $449/mo | `price_1UKxdoBJKzz24nko9e1YcOg4` |

Live prices are mirrored under the same lookup keys before go-live, so no code
or price id changes between environments.

## Secrets (set on the hosted Supabase project, never committed)

Set with `supabase secrets set` or in the dashboard (Edge Functions → Secrets):

- `STRIPE_SECRET_KEY` — a **restricted** key (`rk_...`) with write access to
  Checkout Sessions, Customers, Subscriptions and the Billing Portal. Use the
  sandbox key on staging, the live key on production.
- `STRIPE_WEBHOOK_SECRET` — the signing secret (`whsec_...`) from the webhook
  endpoint you create in Stripe (see below). It exists only after the endpoint
  is created, so this is set last.
- `APP_URL` — the app origin used to build Checkout success/cancel URLs and the
  billing-portal return URL (e.g. `https://app.vendorclr.com`, or the staging
  origin).

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically into Edge Functions; do not set them.

## Deploy

```
supabase functions deploy create-checkout --project-ref <ref>
supabase functions deploy stripe-webhook  --project-ref <ref>
supabase functions deploy billing-portal  --project-ref <ref>
```

`verify_jwt` per function is pinned in `supabase/config.toml`.

## Webhook endpoint in Stripe

Create one endpoint per environment pointing at:

```
https://<project-ref>.functions.supabase.co/stripe-webhook
```

Subscribe to: `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`. Copy the
signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy (or set the secret,
which takes effect without a redeploy).

## Test (sandbox)

1. Sign up a fresh account on staging.
2. Start checkout for a plan; pay with card `4242 4242 4242 4242`, any future
   expiry/CVC, and fill the "Company name" field.
3. Confirm the webhook created a `companies` row (`activation_status=activated`,
   `service_status=onboarding`), a `company_members` owner row, a
   `company_onboarding` row, and two `audit_log` rows; and that `stripe_events`
   has the event marked `processed_at`.
4. Cancel in the billing portal and confirm `subscription_status` and
   `activation_status` update via `customer.subscription.updated/deleted`.

## Notes

- Idempotency: every event id is recorded in `stripe_events` before processing;
  redelivered events are no-ops. Handler failures return 500 so Stripe retries.
- One workspace per account: `create-checkout` and the webhook both refuse to
  create a second company for an account that already has one.
- Discounts ride Checkout's promotion codes (`allow_promotion_codes`), so public
  pricing never shows crossed-out prices.
