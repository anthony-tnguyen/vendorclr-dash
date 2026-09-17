# Backup and restore

Status: Task 13 (deployment, backup and smoke matrix).
Last verified against the live org/projects on 2026-09-17.

This is a **runbook, not an executed drill**. Per this task's explicit
scope boundary, the actual "restore the latest production backup into an
isolated project, run reconciliation, then destroy the isolated copy"
sequence was **not run** in this session - it is expensive, consequential,
and touches production-adjacent infrastructure in ways a single
unsupervised dispatch should not decide to do on its own. What follows is
the complete, ready-to-run procedure: exact steps, exact
dashboard/CLI actions, a reconciliation checklist, and the exact teardown -
so that when this is approved to actually run, no design decisions are
left to whoever runs it. This mirrors Task 0A's own precedent for a
billing-blocked feature (branch protection - see
`docs/operations/release-process.md` §3): document the ready-to-run
procedure precisely, do not silently skip it or fake having done it.

## Blocking prerequisite, found while writing this runbook

**The VendorClr Supabase organization (`oautogyhogurhwndvluj`) is currently
on the Free plan** (confirmed live via the Supabase MCP connector's
`get_organization` call: `"plan": "free"`). Per Supabase's own documented
backup policy:

> We automatically back up all Pro, Team, and Enterprise Plan projects on a
> daily basis... We recommend that free tier plan projects regularly
> export their data using the Supabase CLI `db dump` command and maintain
> off-site backups.

**This means production (`fzrcowwonezflydicpbd`) has no automatic daily
backup and no Point-in-Time Recovery today**, on the org's current plan.
"Restore the latest production backup" is not executable as literally
worded until one of two things happens:

1. **The org is upgraded to Pro or above** (a billing decision for the
   account owner, same class of decision as the branch-protection plan gate
   in `release-process.md` §3 - not something an engineering session should
   decide or execute), which enables both daily backups and, optionally,
   PITR as a paid add-on; or
2. **A manual `supabase db dump` snapshot is taken and stored off-site**,
   per Supabase's own stated recommendation for Free-tier projects, and
   that dump is what gets restored instead of a platform-managed backup.

Both procedures are documented below (§A for the platform-backup path once
the plan is upgraded, §B for the `db dump` path that works today). **Until
someone runs one of these to actually create a real backup, there is
nothing yet to restore** - this is the single most important finding this
task's backup-restore work turned up, and it belongs in the next
operations review, not buried in a runbook nobody re-reads.

## Recovery objective (proposed - not yet a customer-facing commitment)

<!-- PENDING LEGAL/PRODUCT APPROVAL -->

**Every number in this section is a PROPOSED target, not a decided SLA.**
Nothing below may be presented to a customer, in a contract, SLA, or
support conversation, as VendorClr's actual recovery commitment until
counsel/the product owner has reviewed and approved it - same posture
`docs/operations/data-retention.md` already establishes for retention
periods, applied here to recovery objectives.

| Term                                                                      | Proposed target                                                                                                                                                                     | What it means concretely                                                                                                                                                                                                                                                                        | How it would be measured                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO** (Recovery Point Objective) - how much data loss is acceptable     | **24 hours** on the current (Free-plan, manual-`db dump`) posture; **would drop to as low as the Supabase PITR granularity (minutes) if/when the org upgrades and PITR is enabled** | On today's posture, restoring means replaying the most recent manual dump - anything written after that dump and before an incident is lost. A daily cron-scheduled `db dump` (not yet set up - see §B) would bound this to "at most 24 hours old."                                             | Compare the dump's own timestamp (embedded in its filename, per §B's convention) against the incident's start time; the gap is the actual RPO realized for that incident, which should be ≤ the target. |
| **RTO** (Recovery Time Objective) - how long a restore is allowed to take | **4 hours** for a full production restore into a fresh project, end-to-end (create project, restore, reconciliation, cutover)                                                       | This is a proposed ceiling for how long the business could tolerate production being degraded/unavailable during a real recovery, not a technical claim that every step below literally takes that long today (none of it has been timed against a real production-sized dataset by this task). | Time from "incident declared" to "reconciliation checklist below passes and traffic is cut over," logged in the incident's own retro (see `docs/operations/incident-response.md`).                      |

These numbers are deliberately conservative placeholders reflecting the
current Free-plan posture, not an aspirational target - once the org
upgrades and PITR is enabled, both should be revisited and very likely
tightened, and that revision should go through the same approval gate as
the numbers themselves.

## §A - Restoring a platform-managed backup (once the org is on Pro+)

**Prerequisite:** the org plan is Pro/Team/Enterprise, and at least one
platform-managed backup (daily automatic, or PITR if enabled) exists for
`fzrcowwonezflydicpbd`.

### A.1 - Snapshot the current row counts BEFORE touching anything

Run this against **production**, not the isolated copy, before starting
the restore, so the reconciliation checklist in §C has something concrete
to compare against:

```bash
# Requires VENDORCLEAR_SUPABASE_URL / VENDORCLEAR_SERVICE_ROLE_KEY pointed
# at fzrcowwonezflydicpbd - same credentials scripts/export-company.ts uses.
# There is no single existing script that dumps every table's row count;
# the closest existing building block is scripts/lib/companyScopedTables.ts's
# COMPANY_SCOPED_TABLES list (company-scoped tables only). For a whole-
# project reconciliation, run this ad hoc against every table name in
# supabase/README.md's schema listing, or write a one-off script following
# scripts/export-company.ts's exportCompanyTables() pattern but without the
# `.eq("company_id", ...)` filter.
```

Record the output (table name → row count) as `pre-restore-counts.json` -
this is the baseline §C's reconciliation compares the restored copy
against.

### A.2 - Create the isolated target project

Via the Supabase dashboard (**not** the MCP connector's own
`restore_project` tool, which restores IN PLACE on the same project - the
whole point of this drill is an ISOLATED copy that never touches
production):

1. **Create a new, separate Supabase project** - same organization
   (`oautogyhogurhwndvluj`), same region (`us-east-2`) as production for
   parity, name it unambiguously, e.g.
   `vendorclr-restore-drill-<YYYY-MM-DD>`.
2. **Dashboard → Database → Backups → Scheduled backups** on the
   **production** project (`fzrcowwonezflydicpbd`). Find the most recent
   backup (or, if PITR is enabled, pick the target timestamp).
3. Use the dashboard's **"Restore to a new project"** action (Supabase
   supports restoring a backup into a project other than the one it came
   from - confirm this exact control's current label/location in the
   dashboard, since Supabase's UI has moved this before) targeting the new
   isolated project created in step 1. If the dashboard does not offer
   "restore to a different project" for your plan tier, use the CLI path
   instead:
   ```bash
   supabase login
   supabase projects list                     # confirm the new project's ref
   supabase db dump --db-url <production-connection-string> -f production-backup.sql
   supabase db push --db-url <new-project-connection-string> < ... # or psql restore, see §B.3
   ```
   (This CLI path is effectively §B's manual-dump restore, applied to a
   platform-exported dump instead of a `db dump` you took yourself - the
   restore mechanics from here on are identical; skip to §B.3.)

### A.3 - Continue with the shared reconciliation and teardown

Once the isolated project has the restored data, proceed to §C
(reconciliation) and §D (teardown) - both are shared between the §A and §B
paths.

## §B - Restoring a manual `supabase db dump` (works today, Free plan)

### B.1 - Take the dump (this is also the "create a backup at all" step, since none exist automatically on Free)

```bash
# Run from a machine with the Supabase CLI installed and authenticated
# (`supabase login`), against production's connection string (Settings →
# Database → Connection string on the fzrcowwonezflydicpbd dashboard - never
# paste this into a chat session or commit it to git).
supabase db dump --db-url "<production connection string>" \
  -f "vendorclr-production-$(date +%Y-%m-%dT%H-%M-%S).sql"
```

Store the resulting `.sql` file off-site (encrypted at rest - it contains
every customer's compliance data), per Supabase's own recommendation for
Free-tier projects. **This step, run on a schedule (e.g. nightly via a cron
job on a machine with the CLI and credentials, or a scheduled GitHub
Actions job using a repository secret for the connection string), is what
the RPO in the table above is actually bounded by** - until it exists as a
recurring job, there is no "latest backup" to restore at all, drill or not.

### B.2 - Snapshot pre-restore row counts

Same as §A.1 above - run before touching the isolated project, against
production.

### B.3 - Create the isolated project and restore the dump into it

1. **Create a new, separate Supabase project**, same as §A.2 step 1.
2. Get its connection string (**Settings → Database → Connection string**
   on the new project's dashboard).
3. Apply the migrations first, so the schema exists to restore data into -
   this dump is a data-only or full dump depending on how it was taken;
   if it is schema+data, skip this step:
   ```bash
   # Only if the dump does not already include schema:
   supabase link --project-ref <new-project-ref>
   supabase db push   # applies supabase/migrations/ to the new project
   ```
4. Restore the dump:
   ```bash
   psql "<new project connection string>" -f vendorclr-production-<timestamp>.sql
   ```

## §C - Reconciliation checklist (shared by §A and §B)

Run every check below against the **isolated restored copy**, comparing
to the pre-restore baseline captured in §A.1/§B.2. All checks should pass
before considering the restore validated; any mismatch is the drill
finding a real gap, not a script bug to explain away.

- [ ] **Row counts per table match the pre-restore baseline exactly**, for
      every table in `supabase/README.md`'s schema listing - not just the
      company-scoped ones `scripts/export-company.ts` already covers. A
      mismatch here (especially fewer rows in the restore than the
      baseline) means data loss between the backup's timestamp and now -
      expected if the backup is not brand new (that gap IS the realized
      RPO for this drill), but must be attributed to that gap explicitly,
      not silently accepted.
- [ ] **`select * from supabase_migrations.schema_migrations order by
version` on the restored copy matches `list_migrations` on
      production** - the restored schema version should be identical to
      (or, if the backup predates a recent migration, an exact prefix of)
      production's current migration list.
- [ ] **Spot-check a handful of real records** (not just counts - counts
      can match while data is subtly wrong):
  - [ ] Pick 3-5 real `companies` rows (from the pre-restore baseline, by
        id) and confirm their `name`/`plan`/`subscription_renews_on` match
        between the baseline query and the restored copy.
  - [ ] Pick 3-5 `vendor_policies` rows with a non-null
        `expiration_date` and confirm the exact date, `carrier_name`, and
        `policy_number` match.
  - [ ] Pick 1-2 `vendor_documents` rows and confirm the `storage_path`
        field is present and the `sha256` matches what's on file in the
        baseline - **note storage objects themselves are a SEPARATE
        concern from the database restore** (Supabase Storage buckets are
        not necessarily included in a `db dump`/platform backup the same
        way table rows are - confirm this explicitly for whichever restore
        path was used, and if storage objects were not restored, that is a
        real gap to record, not something to gloss over).
  - [ ] Confirm RLS still behaves correctly on the restored copy: as a
        non-service-role client, querying another company's `vendors` row
        should return zero rows, exactly as it does on production (see
        `supabase/tests/rls.test.ts` for the same assertion this project's
        own PGlite suite already makes - re-run it, or a manual equivalent,
        against the restored copy specifically).
- [ ] **`get_advisors` (security) on the restored copy matches the same
      accepted pattern documented in this task's own completion report**
      (the ~18-20 `SECURITY DEFINER`/authenticated-executable WARNs, the
      `upload_rate_limit_counters` INFO) - confirms the restore did not
      silently drop a policy or grant along the way.

## §D - Teardown (destroying the isolated copy)

**Before deleting anything, triple-confirm the project ref you are about
to delete is the ISOLATED RESTORE COPY, never `fzrcowwonezflydicpbd`
(production) or `ukbgjriqszthtgwxyirr` (staging).** Read the project name
and ref back from the dashboard or `list_projects` immediately before the
delete call - do not rely on memory of which one you created five steps
ago.

1. Confirm via the dashboard or `mcp__<supabase>__list_projects` (or
   `supabase projects list`) that the project ref you are about to delete
   matches the name you gave it in §A.2/§B.3 step 1
   (`vendorclr-restore-drill-<date>`), and does **not** match
   `fzrcowwonezflydicpbd` or `ukbgjriqszthtgwxyirr`.
2. Delete it via **Project Settings → General → Delete Project** on the
   dashboard (requires typing the project's name to confirm - Supabase's
   own built-in safeguard against exactly this class of mistake), or
   `supabase projects delete <isolated-project-ref>` via the CLI.
3. Record in the incident/drill log: which project ref was deleted, at
   what time, by whom, and a copy of the reconciliation checklist's
   results (pass/fail per item) - this is the artifact that proves the
   drill happened and what it found, the same "smoke artifacts identify
   revision/time/result" discipline `scripts/smoke-production.ts` applies
   to the ordinary smoke suite.
4. Securely delete the local `.sql` dump file used for the restore (or move
   it to the project's normal off-site backup storage, if that's where
   scheduled dumps are meant to live long-term) - it contains real customer
   data and should not linger on whichever machine ran the restore.

## What this task did NOT do

- It did not upgrade the Supabase org's billing plan (a decision for the
  account owner, same reasoning as every other billing-gated item in this
  project's history).
- It did not take a real `supabase db dump` of production, create an
  isolated project, restore into it, or delete anything. Every step above
  is written to be followed exactly, not asserted as already having
  happened.
- It did not set up the recurring `db dump` cron job §B.1 describes as the
  actual backup-creation mechanism this org currently needs. That is the
  single highest-priority follow-up this document identifies - open a
  tracked task for it rather than leaving it implied here.
