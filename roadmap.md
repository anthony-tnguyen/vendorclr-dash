# Roadmap

## Activation-code access model (approved plan: `.lovable/plan/activation-code-access-model-2026-09-18.md`)

- [ ] PR 1 — Database migration file `20260919000100_activation_codes.sql` (activation columns, backfill, `activation_codes` table, definer functions, audit widening) + open sign-up + `/demo` screen + access enforcement in `AppShell`
- [ ] PR 2 — Staff activation console (`/dashboard/admin/activation-codes`), companies-page revoke/restore, retire signup-invite surface
- [ ] PR 3 — Database + app tests for activation, copy audit of touched screens, full suites + build + staging journey

## Carried from the earlier approved plan

- [ ] Stage 2 — Teammate access UI + `/accept-invite/$token`
- [ ] Stage 3 — Vendor/broker contacts + multi-recipient document requests
- [ ] Stage 4 — Vendor upload portal rebuilt on submission packages
- [ ] Stage 5 — Deficiency + exception UI
- [ ] Stage 6 — Review editing, CSV import UI, reports/CSV export, `/terms` + `/privacy`

## Waiting on the user

- [ ] Settings audit-history check: confirm a change-history entry appears after saving in Dashboard → Settings
- [ ] Apply `supabase/migrations/20260919000100_activation_codes.sql` and report the verification output
- [ ] Confirm the customer-facing wording "activation code"
