# Environment matrix

Status: Task 13 (deployment, backup and smoke matrix).
Last verified against the live projects on 2026-09-17.

> **2026-09-22 observation (not a full re-verification):** at the production deploy of the
> contacts/suppression change, the production `process-document-jobs` Edge Function reported
> `notConfigured`, which means the `ANTHROPIC_API_KEY` Edge Function secret was unset on
> production that day. That contradicts the "one live key, used today" wording in the
> provider table below. The Worker-side key was not checked. Confirm the Edge Function
> secrets before relying on either statement. `list_migrations` on 2026-09-22 showed staging
> and production at schema parity with `main`.

This is the authoritative list of every environment-specific value the
implementation plan names for Task 13, split into a STAGING column and a
PRODUCTION column, with an explicit note on whether each one is **already
genuinely separate** or **not yet separately provisioned**.

**Honest summary, per the plan's own Definition of Done ("the environment
matrix has no shared credentials"):**

- Supabase URL / anon key / service role key are **genuinely separate
  today** - staging is now a real, distinct Supabase project
  (`ukbgjriqszthtgwxyirr`), provisioned in this task, with its own
  credentials that share nothing with production (`fzrcowwonezflydicpbd`).
- App origin is **not yet separately provisioned** - no staging Cloudflare
  Workers deployment exists yet (see `docs/operations/release-process.md`
  §6: the deploy job itself is future work).
- Resend, Anthropic, VirusTotal, Sentry, Turnstile, and the Resend webhook
  signing secret are **NOT yet separately provisioned**. Today there is
  exactly one of each (used by production), and staging has **no value
  configured for any of them** - not a shared copy, an absence. Until each
  is separately created (see `docs/operations/provider-setup.md`), this
  matrix is honestly **partially done**, not complete: those six rows are
  the concrete remainder.

## Supabase

| Value                    | Staging                                                                                                                                                                                                                    | Production                                                                                                                                                                                                                                 | Status                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project ref              | `ukbgjriqszthtgwxyirr`                                                                                                                                                                                                     | `fzrcowwonezflydicpbd`                                                                                                                                                                                                                     | **Separate.** Two distinct Supabase projects, same org (`oautogyhogurhwndvluj`), both `us-east-2`.                                                              |
| Project URL              | `https://ukbgjriqszthtgwxyirr.supabase.co`                                                                                                                                                                                 | `https://fzrcowwonezflydicpbd.supabase.co`                                                                                                                                                                                                 | **Separate.**                                                                                                                                                   |
| Anon / publishable key   | `sb_publishable_rhwtd7hHRjP-9yfYyiPcYg_km_n1jrT` (legacy anon JWT also available via `get_publishable_keys`)                                                                                                               | `sb_publishable_74gXHZ3hiC5Sp2x8bLazVg_8K5mDsFI`                                                                                                                                                                                           | **Separate.** Public by design (RLS is the real boundary) - safe to read here.                                                                                  |
| Service role key         | Not printed in this doc (never a value to commit to git) - fetch via the Supabase dashboard (Settings → API → `service_role` secret) or `supabase login && supabase projects api-keys --project-ref ukbgjriqszthtgwxyirr`. | Same, for `fzrcowwonezflydicpbd`.                                                                                                                                                                                                          | **Separate**, by construction (each project mints its own), but the _value_ was never fetched or stored anywhere in this task - see the Vault-secret gap below. |
| Migration head           | `20260917001600_reporting_audit_snapshots` plus the follow-up `schedule_compliance_housekeeping` (all 43 files in `supabase/migrations/` applied, in order, on 2026-09-17 - see this task's own verification output)       | Same 43 migrations (already merged/applied incrementally across Tasks 0A-12)                                                                                                                                                               | **Aligned.** `list_migrations` on both projects reports the same 43 names.                                                                                      |
| Deployed application SHA | Not deployed anywhere yet - no staging Cloudflare Workers Build/App exists (see App origin below)                                                                                                                          | See the live Cloudflare Workers dashboard for the currently-deployed build's git SHA; this repo has no automated "record the deployed SHA" step yet (Task 13 does not add a deploy pipeline - see `docs/operations/release-process.md` §6) | **Gap**, same root cause as App origin.                                                                                                                         |

## App origin

| Value      | Staging                                                           | Production                                                                | Status                                                                                                                                                                                                                                                     |
| ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App origin | Not provisioned - no staging Cloudflare Workers deployment exists | The live production Cloudflare Workers URL (see the Cloudflare dashboard) | **Not yet separately provisioned.** `.github/workflows/staging-smoke.yml` already expects a `STAGING_URL` GitHub Environment variable once one exists (see `docs/operations/release-process.md` §4/§6 for why the deploy job itself is still future work). |

## Third-party providers (all currently shared / staging-absent)

| Value                                                   | Staging                                             | Production                                                                                                       | Status                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resend API key (`RESEND_API_KEY`)                       | **Not configured** - no staging-specific key exists | One live key, used today                                                                                         | **Not yet separately provisioned.** See provider-setup.md §Resend for the exact steps to create a second key scoped to a staging sending domain.                                                                                                                                               |
| Resend webhook signing secret (`RESEND_WEBHOOK_SECRET`) | **Not configured**                                  | One live `whsec_`-prefixed secret, set as a production Edge Function secret                                      | **Not yet separately provisioned.** A staging `resend-webhook` Edge Function is deployed (this task) but has no secret set - it fails closed (401) on every call until one is set, which is the correct default, not a bug.                                                                    |
| Anthropic API key (`ANTHROPIC_API_KEY`)                 | **Not configured**                                  | One live key, used today                                                                                         | **Not yet separately provisioned.** Staging's `process-document-jobs`/`retry-failed-documents` Edge Functions are deployed but will report `notConfigured: true` on every invocation until this is set (verified live by `scripts/smoke-production.ts`'s `extraction_worker_invocation` case). |
| VirusTotal API key (`VIRUSTOTAL_API_KEY`)               | **Not configured**                                  | One live key, used today (optional even in production - see `.env.example`)                                      | **Not yet separately provisioned.** Uploads on staging will record `malware_scan_status = 'not_configured'` for every document until this is set - a real, checkable signal, not a silent gap (see the smoke script's `malware_scan_status_recorded` case).                                    |
| Sentry DSN (`VITE_SENTRY_DSN`)                          | **Not configured**                                  | One live DSN, used today                                                                                         | **Not yet separately provisioned.** A DSN is not secret (it's meant to ship in client JS - see `.env.example`), so this is lower urgency than the others, but staging errors currently have nowhere to report to.                                                                              |
| Turnstile secret key (`TURNSTILE_SECRET_KEY`)           | **Not configured**                                  | **Not configured either** - no real Turnstile account exists in this codebase yet, per `.env.example`'s own note | **Neither environment has this yet.** Not a staging-specific gap - see provider-setup.md §Turnstile for what standing this up for both environments would take.                                                                                                                                |

## Vault secrets (pg_cron → pg_net, read by the scheduled Edge Function invocations)

These are **not** third-party provider credentials - they are the two
Supabase Vault secrets `project_url`/`service_role_key` that every
`cron.schedule()` job in `supabase/migrations/*.sql` reads via
`vault.decrypted_secrets` to call this project's own Edge Functions (see
`supabase/README.md`'s own documentation of this pattern). Listed here
because they are still environment-specific values a human must set.

| Secret             | Staging (`ukbgjriqszthtgwxyirr`)                                                                                                                            | Production (`fzrcowwonezflydicpbd`) | Status                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `project_url`      | Set in this task via `select vault.create_secret(...)` through the Supabase MCP connector's `execute_sql` tool - `https://ukbgjriqszthtgwxyirr.supabase.co` | Already set (pre-existing)          | **Done**, and correctly points at staging's own URL, never production's. |
| `service_role_key` | **NOT set.** See the explicit gap note below.                                                                                                               | Already set (pre-existing)          | **Gap - documented, not silently skipped.**                              |

### The `service_role_key` Vault-secret gap, explicitly

`vault.create_secret()` **is** callable through the Supabase MCP
connector's `execute_sql` tool - confirmed live in this task by setting
`project_url` successfully that way. Vault secrets are ordinary
Postgres/pgsodium objects, unlike Edge Function environment variables (a
separate Supabase platform feature this connector's own tool list has no
tool for - see `provider-setup.md`'s citation of that established
limitation).

What blocked setting `service_role_key` specifically is **not** a
connector limitation on `vault.create_secret()` itself - it is that this
session has no tool that returns a project's actual `service_role` API key
value. `get_publishable_keys` deliberately only returns the anon/publishable
keys (see its own tool description); there is no `get_service_role_key`
equivalent. Fabricating a placeholder value here would be actively worse
than leaving the secret unset: an unset secret makes every cron-triggered
Edge Function invocation fail its own `isServiceRoleRequest()` check
cleanly (403, logged, no data touched) - the same fail-safe behavior these
functions already have for any unrecognized caller. A **wrong** value
would look configured while silently never authenticating, which is a much
harder failure mode to notice.

**To close this gap:** a human with dashboard access to the staging project
must run, once:

```sql
select vault.create_secret(
  '<the real service_role key from Settings → API on the ukbgjriqszthtgwxyirr project>',
  'service_role_key'
);
```

either via the Supabase SQL Editor or `supabase db execute` with the
project's own CLI credentials - never pasted into a chat session or
committed to this repo. Until this runs, staging's four cron jobs
(`send-renewal-reminders-daily`, `retry-failed-documents-hourly`,
`process-document-jobs-every-minute`, `compliance-housekeeping-daily`) are
scheduled and active (confirmed via `select * from cron.job` in this task)
but every invocation's `net.http_post` call carries an empty/null
`Authorization: Bearer` header and will be rejected by the target Edge
Function's own `isServiceRoleRequest()` check.

## Node/server env vars (deploy secrets, per `serverClient.server.ts`)

The exact names the Node/Cloudflare side of this app reads (see
`.env.example` for the authoritative source and each var's own graceful-
degradation behavior when unset):

| Var                            | Staging value                                                                                            | Production value                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `VITE_SUPABASE_URL`            | `https://ukbgjriqszthtgwxyirr.supabase.co`                                                               | `https://fzrcowwonezflydicpbd.supabase.co`       |
| `VITE_SUPABASE_ANON_KEY`       | `sb_publishable_rhwtd7hHRjP-9yfYyiPcYg_km_n1jrT`                                                         | `sb_publishable_74gXHZ3hiC5Sp2x8bLazVg_8K5mDsFI` |
| `VENDORCLEAR_SUPABASE_URL`     | Same as `VITE_SUPABASE_URL` above                                                                        | Same as `VITE_SUPABASE_URL` above                |
| `VENDORCLEAR_SERVICE_ROLE_KEY` | Not fetched/stored by this task - see the Vault-secret gap note above for the same underlying limitation | Already set as a live deploy secret              |
| `VITE_APP_URL`                 | Not set - no staging deployment exists yet                                                               | The live production origin                       |
| `RESEND_API_KEY`               | Not configured                                                                                           | Configured                                       |
| `RESEND_WEBHOOK_SECRET`        | Not configured                                                                                           | Configured                                       |
| `ANTHROPIC_API_KEY`            | Not configured                                                                                           | Configured                                       |
| `VIRUSTOTAL_API_KEY`           | Not configured                                                                                           | Configured                                       |
| `VITE_SENTRY_DSN`              | Not configured                                                                                           | Configured                                       |
| `TURNSTILE_SECRET_KEY`         | Not configured                                                                                           | Not configured (neither environment has this)    |
| `UPLOAD_ABUSE_IP_HMAC_SECRET`  | Not set - **required** (fails closed) for the anonymous upload portal to work at all on staging          | Configured                                       |

## What this means for staging today

Staging (`ukbgjriqszthtgwxyirr`) has schema/function/cron parity with
production (verified in this task - see the migration/function/advisor
counts in the task's own completion report), but is **not yet a runnable
environment for a vendor-facing smoke test that needs email, extraction, or
malware scanning to actually happen** - those calls will all report their
already-graceful "not configured" outcomes rather than exercising the real
provider integration. `scripts/smoke-production.ts` is written to treat
each of those as a **real, correctly-reported signal** (not a false pass)
so this matrix's gaps show up automatically the next time the script runs,
rather than needing to be manually cross-checked against this document.
