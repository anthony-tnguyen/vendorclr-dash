# Release process

Status: Tasks 0A and 0B (release engineering and role-flow browser coverage).
Last verified against the live repo on 2026-09-15.

## 1. PR #25

PR #25 ("Gate business signup behind admin-issued invite codes") was
reviewed and merged prior to this task, as `d5f91c6` on `main`. No
re-decision was needed here, and this task does not touch signup-invite
schema or code.

## 2. CI checks

`.github/workflows/ci.yml` runs four jobs on every push and pull request:

| Job         | Purpose                                                                                                                                   | Required to merge? |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `quality`   | install, `tsc --noEmit`, `eslint .`, `prettier --check .`, `vitest run`                                                                   | **Yes**            |
| `db-verify` | `vitest run --config vitest.db.config.ts` against a real Postgres (PGlite/WASM) - the only check that catches an RLS regression           | **Yes**            |
| `build`     | `vite build` (nitro `cloudflare-module` preset) → uploads `dist` as an artifact                                                        | **Yes**            |
| `e2e-smoke` | Downloads the `build` artifact, boots it under `wrangler dev`, runs the full `e2e/**` Playwright suite against the real production bundle | **Yes**            |

Local equivalents:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run db:verify
bun run build
bun run e2e                              # after `bun run build`; boots wrangler dev itself
```

### Why `e2e-smoke` is a required check

`e2e/smoke.spec.ts` confirms the Worker bundle starts. Task 0B adds
`e2e/role-flows.spec.ts`, which verifies customer triage, administrator role
preview, public invalid-link handling, empty results, permission denial, and
error focus at 1440 x 900 and 390 x 844. The job therefore runs `bun run e2e`
and is a blocking status check.

### `wrangler dev`, not the Vite dev server

`e2e-smoke` and `staging-smoke.yml` both point Playwright at
`bunx wrangler dev --config dist/server/wrangler.json` (see
`playwright.config.ts`), not `vite dev` or `vite preview`. The production
deploy target is nitro's `cloudflare-module` preset, which builds a
Cloudflare Workers module handler (`export default { fetch(request, env,
context) {...} }`) - that file cannot run under plain Node (`node
.output/server/index.mjs` fails; there is no HTTP server to start). Testing
under `vite dev`/`vite preview` would only prove the dev server works, not
the thing that actually gets deployed. `npx vite preview` (what nitro's own
build output suggests) does not work here either - it looks for
`dist/server/server.js`, a path this project's nitro/cloudflare build does
not produce.

`wrangler` is pinned as a devDependency (not resolved fresh via `bunx` from
the registry each run) for reproducibility.

## 3. Branch protection - BLOCKED on GitHub plan tier

**Status: blocked, not applied.** This repository is private and on a
GitHub plan that returns 403 when branch protection is requested via the
API:

```
$ gh api repos/anthony-tnguyen/vendorclr-dash/branches/main/protection -X PUT ...
{"message":"Upgrade to GitHub Pro or make this repository public to enable
this feature.","status":"403"}
```

This is a billing/plan decision for the repo owner, not something an
engineer working in this repo can resolve. **The GitHub plan was not
upgraded as part of this task.**

Once the plan is upgraded (or the repo is made public, or it's moved to an
org that supports protected branches on private repos), apply this exact
ruleset:

```bash
gh api repos/anthony-tnguyen/vendorclr-dash/branches/main/protection \
  --method PUT \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["quality", "db-verify", "build", "e2e-smoke"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

This requires PRs (no direct pushes to `main`), the four required checks
(`quality`, `db-verify`, `build`, `e2e-smoke`), one approval, dismissal of
stale approvals on new pushes, and blocks force pushes and branch deletion. `enforce_admins: true` means this
also applies to repo admins - drop it only with a documented reason.

Equivalent via the UI: **Settings → Branches → Add branch protection rule**
for `main`, then check "Require a pull request before merging" (1 approval,
dismiss stale reviews), "Require status checks to pass" (`quality`,
`db-verify`, `build`), "Require branches to be up to date", and uncheck
"Allow force pushes" / "Allow deletions".

## 4. GitHub Environments

`staging` and `production` GitHub Environments were created:

```bash
gh api repos/anthony-tnguyen/vendorclr-dash/environments/staging -X PUT
gh api repos/anthony-tnguyen/vendorclr-dash/environments/production -X PUT
```

Both succeeded (environments exist, with no protection rules yet).

### Required reviewers on `production` - BLOCKED on the same plan tier

Attempting to add a required-reviewers protection rule to `production` via
the API:

```bash
gh api repos/anthony-tnguyen/vendorclr-dash/environments/production \
  -X PUT \
  -F 'reviewers[][type]=User' \
  -F 'reviewers[][id]=<REVIEWER_GITHUB_USER_ID>'
```

fails with:

```
{"message":"Failed to create the environment protection rule. Please
ensure the billing plan supports the required reviewers protection rule.",
"status":"422"}
```

Same root cause as branch protection: required reviewers on environments
for a private repo needs GitHub Pro/Team (or an appropriate org plan).
**Not applied.** Once the plan is upgraded, either re-run the command above
(look up the reviewer's numeric GitHub user id with `gh api user -q .id`
while authenticated as them, or `gh api users/<login> -q .id`), or use the
UI: **Settings → Environments → production → Required reviewers**.

Until this is in place, nothing technically stops a workflow run from
deploying to `production` without a human clicking approve - **the deploy
owner decision below still has to actually gate the deploy job on the
`production` environment (`environment: production` in whatever workflow
does the deploy) for this to matter once reviewers are configured.**

### No secrets in this repo

No service-role, provider, or deploy credential _values_ were stored
anywhere - not as repository variables, not as environment variables, not
in this repo at all. What follows is the list of **names** a human with
access needs to set (as GitHub _Secrets_, not _Variables_, unless noted)
once these environments are protected and a real deploy workflow exists:

| Name                        | Scope                            | Secret or Variable | Notes                                                   |
| --------------------------- | -------------------------------- | ------------------ | ------------------------------------------------------- |
| `VITE_SUPABASE_URL`         | staging, production              | Variable (public)  | Read client-side; see `src/lib/supabase/env.ts`         |
| `VITE_SUPABASE_ANON_KEY`    | staging, production              | Variable (public)  | Anon key is public by design - RLS is the real boundary |
| `SUPABASE_SERVICE_ROLE_KEY` | staging, production              | **Secret**         | Server-only; see `supabase/README.md`                   |
| `RESEND_API_KEY`            | production (staging optional)    | **Secret**         | Email send; degrades gracefully if unset                |
| `RESEND_WEBHOOK_SECRET`     | production                       | **Secret**         | Inbound webhook signature check                         |
| `ANTHROPIC_API_KEY`         | production (staging optional)    | **Secret**         | Document extraction; degrades gracefully if unset       |
| `VIRUSTOTAL_API_KEY`        | production (optional)            | **Secret**         | Malware scan; degrades gracefully if unset              |
| `CLOUDFLARE_API_TOKEN`      | production (staging if deployed) | **Secret**         | Needed once a real deploy job runs `wrangler deploy`    |
| `CLOUDFLARE_ACCOUNT_ID`     | production (staging if deployed) | Variable           | Not itself sensitive, but scope it anyway               |
| `STAGING_URL`               | staging                          | Variable           | Base URL `staging-smoke.yml` points Playwright at       |

Set these via **Settings → Environments → \<name\> → Environment
secrets/variables**, or `gh secret set NAME --env production` /
`gh variable set NAME --env staging`. This task did not run any of those
commands with real values.

## 5. Repository plan / protected branches - BLOCKED

See §3. This is the same billing constraint; it is not repeated separately
here beyond noting explicitly: **do not attempt to upgrade the GitHub plan
or move the repo to an org from an engineering session** - that's a billing
decision for the repo owner.

## 6. Deploy owner

**Decision (adopted from the implementation plan as-is): GitHub Actions
deploys the existing Cloudflare-compatible Nitro output. Lovable remains a
design/editor preview only and must not be able to bypass GitHub's required
checks or approvals.**

This task does **not** implement that deploy job. `.github/workflows/
staging-smoke.yml` is a smoke-test workflow that runs Playwright against an
_already-deployed_ staging URL (`workflow_dispatch`, or a `STAGING_URL`
environment variable) - it does not deploy anything itself. Building the
actual `wrangler deploy` CD pipeline needs `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` (see table above), which this sandboxed task has no
access to and should not fabricate. That pipeline is future work; when it's
built, its production job should be gated on `environment: production` so
the required-reviewers rule in §4 (once unblocked) actually applies to it.

## 7. Rollback

See `docs/operations/rollback.md`.
