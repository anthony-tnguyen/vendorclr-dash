# Customer data deletion

Status: Task 12 (data lifecycle - Engineer A slice).

`scripts/delete-company.ts` permanently deletes one company's data: every
row in every company-scoped table (via a cascading delete of the
`companies` row itself - see the script's own docblock for why a single
cascading delete covers all 34 tables) plus its private storage objects.
This is irreversible. Follow this runbook; do not run the script casually.

## Required approvals before running this

This script is deliberately hard to misuse destructively. It will refuse to
delete anything unless **all four** of the following are true:

1. **Dry-run output reviewed first.** Running the script with no extra
   flags (or `--dry-run`) is the default and always safe - it reports
   exactly what would be deleted (the same per-table row counts
   `export-company.ts`'s manifest reports, plus the storage object count)
   and deletes nothing. Do this first, always, and have a second person
   review the output before proceeding.
2. **Exact company ID and name confirmation.** `--execute` requires
   `--confirm-name="<exact company name>"`, checked against the company's
   actual on-file name. The id alone (easy to copy-paste without really
   looking at it) is not sufficient friction for an irreversible action.
3. **A backup reference.** `--execute` requires
   `--backup-reference="<id/timestamp>"` - record which backup (e.g. a
   Supabase PITR timestamp, or an `export-company.ts` run's output
   directory) this deletion is safe against. The script does not verify
   this backup exists; it is the operator's responsibility to have actually
   taken/confirmed one before recording its reference here. **Run
   `scripts/export-company.ts` for this company first if no other backup is
   available** - see `customer-export.md`.
4. **A second approver.** `--execute` requires
   `--second-approver="<name/id/email>"` - a second human who has reviewed
   and approved this specific deletion, recorded as part of the invocation.
   The script cannot verify this out-of-band; this is a runbook-enforced
   process, not a technical guarantee the tool provides on its own. Do not
   fill this in with your own name.

Missing any of the above (or a `--confirm-name` that doesn't exactly match)
causes the script to refuse and list every unmet requirement - see
`src/tests/data-lifecycle.test.ts`'s `assertDeletionAuthorized()` tests for
the exact behavior.

## Recommended workflow

1. **Export first.** Run `bun scripts/export-company.ts <companyId>` and
   keep the output somewhere durable. This is both your backup reference
   for step 4 above and the record of what existed before deletion.
2. **Dry run.** `bun scripts/delete-company.ts <companyId>` with no other
   flags. Review the per-table row counts and storage object count against
   what you expect for this company.
3. **Get a second approver.** Share the dry-run output and the export with
   a second person (not the operator running the deletion) for review and
   explicit sign-off.
4. **Execute.**
   ```bash
   bun scripts/delete-company.ts <companyId> \
     --execute \
     --confirm-name="<exact company name from the dry run>" \
     --backup-reference="<export directory path or PITR timestamp from step 1>" \
     --second-approver="<second approver's name/id/email>"
   ```
5. **Reconcile.** Re-run the dry run
   (`bun scripts/delete-company.ts <companyId>`) - the company id should no
   longer resolve to a company at all ("No company found... Nothing to
   delete."), confirming every row and storage object counted in step 2 is
   actually gone. Compare against the export's `manifest.json` from step 1:
   the manifest's row counts are what should now be zero everywhere.

## What is never deleted

`auth.users` rows are never touched by this script, deliberately. A
person's login identity may span multiple companies (the same email invited
to two different companies) or predate this one in ways the script cannot
safely assume it fully understands. `company_members` rows that link a user
to this company ARE deleted (cascaded, like every other table), which
removes the user's access to this company - but the underlying `auth.users`
row, and any access that row still has to other companies, is left alone.
Removing a user's login identity entirely, if ever needed, is a separate,
deliberate action outside this script's scope.

## Relationship to `data-retention.md`

This script is the mechanism; `data-retention.md` is the (currently
proposed, not yet approved) policy for when deletion should happen at all.
Running this script is always a deliberate, approved, human-triggered
action per the workflow above - it is never triggered automatically by age
or a retention-period calculation, and nothing in this codebase currently
does that. See the plan's own Task 12 constraint: "Enforce scheduled
deletion only after approval."
