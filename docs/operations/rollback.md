# Rollback

Two independent things can need rolling back after a bad release: the
**application** (the deployed Worker) and the **database** (Supabase
migrations). They are rolled back differently, and a database rollback is
**never** a destructive down-migration once customer data exists.

## Application rollback (revision rollback)

The deploy target is a Cloudflare Worker built from this repo's Nitro
`cloudflare-module` output (see `docs/operations/release-process.md` §6).
The application layer is stateless - it holds no data of its own - so
rolling it back is safe and reversible:

1. Identify the last known-good commit on `main` (the one before the bad
   deploy).
2. Re-run the deploy job (once it exists - see §6 of release-process.md)
   against that commit's built artifact. Concretely, once GitHub Actions
   owns deploys: re-run the "Deploy" workflow from that earlier commit via
   **Actions → Deploy → Run workflow**, selecting the known-good SHA/ref -
   or `git revert` the bad commit(s) on `main` and let CI/CD redeploy the
   revert normally, whichever is faster to get through required checks.
3. If Cloudflare's own deployment history is available (Workers keeps
   previous deployments), an immediate stop-gap is Cloudflare's own
   instant-rollback ("Workers & Pages → \<project\> → Deployments →
   Rollback to this deployment") while the redeploy-from-Actions path above
   runs through CI. Use this only as a bridge - it does not update `main`,
   so the next merge would silently re-deploy the broken version.
4. Confirm the rollback with the same SSR smoke check CI uses: point
   `staging-smoke.yml` (or an ad-hoc `PLAYWRIGHT_BASE_URL=<url> bunx
playwright test e2e/smoke.spec.ts`) at the rolled-back URL.

Application rollback never touches the database. It is safe to do
immediately, without a migration review, because no schema or data changes
are involved.

## Database rollback (forward-only repair)

**There is no destructive down-migration path once customer writes exist,
and none should ever be written.** A `DROP COLUMN`/`DROP TABLE`-style down
migration is only safe on a database with zero real rows in the affected
tables - the moment a real vendor, document, or compliance record has been
written, reversing a migration by deleting the structure that holds it
destroys data that cannot be reconstructed from the application layer.

Concretely, this project's migrations under `supabase/migrations/` are
**additive and forward-only** (see `supabase/README.md`). The recovery path
for a bad migration is always another, later migration:

1. **Assess blast radius first.** Query what the bad migration actually
   changed or broke (`supabase/tests/` + `bun run db:verify` locally
   against a copy of the schema is the fastest way to reproduce). Never
   guess at the fix under production pressure - read the migration that
   caused the problem.
2. **Write a forward migration that repairs the state**, e.g.:
   - A bad `ALTER TABLE ... ADD COLUMN ... NOT NULL` with a wrong default:
     ship a new migration that corrects the default/backfills the right
     values - do not drop the column.
   - A bad RLS policy that over- or under-shares rows: ship a new migration
     that replaces the policy (`DROP POLICY` + `CREATE POLICY` in the same
     migration is fine - that's forward-only, it's the _table/column_ data
     that must never be dropped once written, not every single object).
   - A bad trigger/function causing incorrect writes: ship a migration
     fixing the function, then a **data-repair migration** (or one-off,
     reviewed `UPDATE`/backfill script, run and recorded the same as any
     other migration) to correct rows already written incorrectly.
3. **Run `bun run db:verify` against the new migration** before it ships -
   this is the RLS/tenancy regression check (see
   `docs/operations/release-process.md` §2); it is the only thing in CI
   that would catch a repeat of an RLS-shaped bug.
4. **Apply the repair migration through the same path as any other
   migration** - do not hand-run SQL against the production database
   outside of the migration history. An un-tracked manual fix means the
   next environment rebuilt from `supabase/migrations/` (a new staging env,
   a disaster-recovery restore) silently reintroduces the bug.
5. If data was already corrupted by the bad migration (not just schema),
   restoring specific rows from a Supabase point-in-time backup (where
   available on the project's plan) is the safety net - Supabase's own
   PITR/backup restore, not a hand-written down migration. Confirm backup
   availability and retention window for the live project before relying on
   this in an incident; this document does not assert what's currently
   configured.

### What "safe" does not mean here

Do not claim, in an incident or otherwise, that a down migration is "safe"
because it was tested against a dev/staging database with no real data.
Staging having empty tables proves nothing about whether the same DROP is
safe against production once real vendors, documents, and compliance
records exist there. The only forward-looking safety property this project
relies on is: migrations are additive, and application code is expected to
tolerate the old and new shape of the schema existing side by side during a
rollout (see any migration under `supabase/migrations/` for the existing
pattern of additive changes).
