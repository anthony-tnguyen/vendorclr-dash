# Provider setup - provisioning separate staging credentials

Status: Task 13 (deployment, backup and smoke matrix).
Last verified against the live repo on 2026-09-17.

`docs/operations/environment-matrix.md` documents that Resend, Anthropic,
VirusTotal, Sentry, and Turnstile currently have **one shared (production)
credential, and no staging credential at all** - not a copy, an absence.
This doc is the concrete "what to actually click/run" for closing that gap,
provider by provider. None of these steps were run by this task - they
each require an account this sandboxed session cannot act on the user's
behalf for (a third-party dashboard login), per the same reasoning
`docs/operations/release-process.md` §3/§4 already establishes for
GitHub's own billing-gated features.

Every provider section below ends with **where the resulting secret needs
to be configured** in two places, because this app has two separate
runtimes with no shared secret store:

1. **This app's own Node/Cloudflare side** - `.env` locally, or a
   Cloudflare Pages/Workers deploy secret in CI/production (see
   `docs/operations/release-process.md`'s "No secrets in this repo" table
   for the exact GitHub Environment secret names this project already
   expects).
2. **Supabase Edge Functions (the Deno side)** - a **separate** secret
   store this project's own Supabase MCP connector cannot reach. This
   limitation is already established elsewhere in this project's history
   (see `supabase/README.md`'s deployment-verification notes and this
   task's own `docs/operations/environment-matrix.md` Vault-secret gap
   section for the parallel case): the connector's `deploy_edge_function`
   tool can push function _code_, but nothing in its tool list sets a
   function's _environment variable_ secrets (`RESEND_API_KEY`,
   `ANTHROPIC_API_KEY`, `VIRUSTOTAL_API_KEY`, `RESEND_WEBHOOK_SECRET`).
   Setting these requires either:
   - the Supabase CLI: `supabase secrets set RESEND_API_KEY=... --project-ref <ref>`, or
   - the dashboard: **Project Settings → Edge Functions → Secrets**.

   Both are human/CLI-only actions outside this session's reach - the same
   class of gap as the `service_role_key` Vault secret.

## Resend (transactional email)

**What to create:** a second Resend account sending domain/API key scoped
to staging, separate from production's.

1. Log in to the Resend dashboard (resend.com) with the account that owns
   the production `compliance.vendorclr.com` sending domain (see
   `supabase/functions/send-renewal-reminders/index.ts`'s `FROM_ADDRESS`
   constant for the exact domain this project already verified).
2. **Domains → Add Domain.** Add a staging-specific subdomain, e.g.
   `staging.compliance.vendorclr.com`, and publish the SPF/DKIM/DMARC DNS
   records Resend gives you - the exact same three-record check
   `scripts/check-email-deliverability.ts` already automates for the
   production domain; run it again against the new staging domain once
   DNS propagates: `bun scripts/check-email-deliverability.ts staging.compliance.vendorclr.com`.
3. **API Keys → Create API Key.** Name it something unambiguous, e.g.
   `vendorclr-staging`, scoped to sending only if Resend's permission model
   allows narrowing it (Domain-restricted, not full account access).
4. **Webhooks → Add Endpoint.** Point a **separate** webhook at staging's
   own `resend-webhook` Edge Function URL:
   `https://ukbgjriqszthtgwxyirr.supabase.co/functions/v1/resend-webhook`
   (see `docs/operations/environment-matrix.md` for why this must be
   staging's own project URL, never production's). Resend issues a
   distinct `whsec_`-prefixed signing secret per webhook endpoint - copy
   it.
5. Configure the results:
   - Node side: `RESEND_API_KEY` (the new staging key) as a Cloudflare
     deploy secret for the `staging` GitHub Environment.
   - Deno side: `supabase secrets set RESEND_API_KEY=<staging key> RESEND_WEBHOOK_SECRET=<staging whsec_...> --project-ref ukbgjriqszthtgwxyirr`.

## Anthropic (document extraction)

**What to create:** a second Anthropic API key, ideally under a separate
workspace/project if the Anthropic Console supports it, so staging's usage
and spend are visible independently of production's.

1. Log in to console.anthropic.com with the account that owns the
   production key already in use (see `src/workflows/documentExtraction.ts`
   and the three Edge Functions that call the same model).
2. If the Console's organization supports workspaces, create a
   `vendorclr-staging` workspace first, so staging's spend/rate limits are
   isolated from production's - **before** minting the key, since a key is
   scoped to the workspace it's created in.
3. **API Keys → Create Key**, named `vendorclr-staging`.
4. Configure the results:
   - Node side: `ANTHROPIC_API_KEY` as a `staging` GitHub Environment
     secret (this app's own extraction paths use it if this project ever
     runs extraction from the Node side - today it does not, but the var
     name is already established in `.env.example`).
   - Deno side (the actual caller today):
     `supabase secrets set ANTHROPIC_API_KEY=<staging key> --project-ref ukbgjriqszthtgwxyirr`
     - this is what `process-document-jobs` and `retry-failed-documents`
       actually read (`Deno.env.get("ANTHROPIC_API_KEY")`).
5. Model access note: this project's Anthropic usage policy pins
   `claude-opus-5` specifically (see every Edge Function's own `MODEL`
   constant) - confirm the new staging key/workspace has access to that
   exact model before relying on it; a key without access degrades to
   `extractDocument()`'s own `"failed"` outcome with an `Anthropic API
error` message, which `scripts/smoke-production.ts`'s
   `extraction_worker_invocation` case will surface as a real (not silent)
   signal.

## VirusTotal (malware scanning)

**What to create:** a second VirusTotal API key. VirusTotal's free tier is
rate-limited per key (historically 4 requests/minute, 500/day) - a shared
key between staging and production risks staging smoke runs starving
production of quota, which is itself a reason to separate these even
though malware scanning is optional/degrades gracefully when unset (see
`src/workflows/malwareScanner.ts`).

1. Log in to virustotal.com with the account that owns the production key.
2. **API key** (under the account profile) - VirusTotal ties one API key
   to one account, so a genuinely separate key means either a second
   VirusTotal account (a free "Community" account is sufficient for this
   product's hash-lookup-only usage) or, if VirusTotal's paid tier supports
   it, a second key/group under the same organization.
3. Configure the result:
   - Node side: not read directly by this app's Node code today (malware
     scanning happens through the same server-side workflow that already
     runs on the service-role client - see `.env.example`'s own comment).
   - Deno side is not applicable either - malware scanning happens in the
     Node/Cloudflare request path (`uploadDocumentForTokenHandler()`), not
     in an Edge Function. Set `VIRUSTOTAL_API_KEY` as a `staging` GitHub
     Environment secret only.

## Sentry (error monitoring)

**What to create:** a second Sentry project (not just a second DSN under
the same project - a DSN is project-scoped, and mixing staging/production
errors into one Sentry project makes triage harder, not easier).

1. Log in to sentry.io with the account/org that owns the production
   VendorClr project.
2. **Projects → Create Project**, name it `vendorclr-staging`, same
   platform (JavaScript/React or whichever the production project uses).
3. Copy the new project's DSN (**Settings → [project] → Client Keys
   (DSN)**).
4. Configure the result: `VITE_SENTRY_DSN` as a `staging` GitHub
   Environment **variable** (not secret - a DSN is meant to ship in
   client-side JS, per `.env.example`'s own note and
   `src/lib/observability/sentryClient.ts`).
5. No Deno-side step: Edge Functions in this project use their own
   zero-import `operationalLog.ts` structured logging (see any Edge
   Function's own docblock), not Sentry.

## Cloudflare Turnstile (bot mitigation on the anonymous upload portal)

**Current state, both environments:** no real Turnstile account exists in
this codebase yet, per `.env.example`'s own note on `TURNSTILE_SECRET_KEY`

- `assertUploadAllowed()` (`src/workflows/uploadAbuse.server.ts`) never
  requires a challenge today because this var has never been set anywhere,
  production included. This is **not** a staging-specific gap to close in
  isolation - standing up Turnstile at all is the prerequisite, and doing it
  for both environments at once is the natural order (avoid a second
  migration of this setup later).

1. Log in to the Cloudflare dashboard with the account this project's
   Workers deployment already uses (see `docs/operations/release-process.md`
   §6 for the `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` this project
   already names as needed once a real deploy job exists).
2. **Turnstile → Add widget.** Create two separate widgets - one per
   environment, each with its own site key/secret key pair, with the
   widget's allowed hostname set to that environment's actual app origin
   (`staging.vendorclr.com` / `vendorclr.com`, once each exists - see
   environment-matrix.md's "App origin" row).
3. Configure the results, per environment:
   - Node side: `TURNSTILE_SECRET_KEY` (server-only) as a GitHub
     Environment secret; a matching `VITE_TURNSTILE_SITE_KEY` (not yet
     named/wired anywhere in this codebase - `uploadAbuse.server.ts`'s own
     docblock flags this as required "for the widget itself" once this is
     actually built) as a GitHub Environment variable.
   - Deno side: not applicable - Turnstile verification happens in
     `uploadAbuse.server.ts` (Node), not in an Edge Function.
4. This also needs actual browser-side widget code added to the vendor
   upload form, which does not exist yet - out of scope for this task
   (a schema/infra dispatch), tracked as future work alongside the rest of
   `uploadAbuse.server.ts`'s own "Non-goals" section.

## Summary: what's still manual after this task

Every provider above needs a human with the relevant dashboard login to
actually click through account/key creation - this cannot be scripted or
automated from this session. What _can_ be automated once the values
exist is applying them: `gh secret set NAME --env staging --body "<value>"`
for the Node/GitHub side, and `supabase secrets set NAME=<value>
--project-ref ukbgjriqszthtgwxyirr` for the Deno side - both one-line CLI
calls once a human has the actual credential in hand.
