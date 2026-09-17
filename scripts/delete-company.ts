#!/usr/bin/env node
/**
 * Task 12 - a standalone operations script, following the same conventions
 * as scripts/check-email-deliverability.ts and scripts/export-company.ts:
 * run by hand from a documented runbook (docs/operations/
 * customer-deletion.md), never imported by anything in src/**, never run on
 * a schedule or unattended - see the confirmation requirements below, which
 * exist specifically to make an unattended/cron invocation impossible.
 *
 * DESTRUCTIVE. This script permanently deletes a company's data. The plan
 * this task implements is explicit: "deletion script requires dry-run
 * output, exact company ID/name confirmation, backup reference and second
 * approver." All four are enforced here, and none can be skipped:
 *
 *   1. Dry-run output - the DEFAULT mode with no extra flags. Reports
 *      exactly what would be deleted (the same per-table row counts
 *      export-company.ts's manifest reports, plus the storage object count)
 *      and deletes nothing. Trivially easy to invoke:
 *        bun scripts/delete-company.ts <companyId>
 *
 *   2. Exact company ID AND name confirmation - actual deletion requires
 *      --execute plus --confirm-name="<exact company name>". The company id
 *      is already the positional argument; requiring the NAME too (checked
 *      against what's actually on file, exact string match) means a
 *      copy-pasted id alone - which proves nothing about whether the
 *      operator has the right company in mind - is not enough to delete.
 *
 *   3. Backup reference - --backup-reference="<string>" is required with
 *      --execute. This script does NOT verify the backup exists; per the
 *      plan's own wording this is a runbook-enforced process, not a
 *      technical guarantee the script alone can provide. It exists to make
 *      the operator record, at the moment of deletion, which backup this
 *      deletion is safe against.
 *
 *   4. Second approver - --second-approver="<name/id/email>" is required
 *      with --execute, for the same reason: this script cannot verify a
 *      second human actually reviewed this out-of-band, it only requires
 *      that fact be recorded as part of the invocation. See
 *      docs/operations/customer-deletion.md for the approval workflow this
 *      is meant to be run inside of, not a substitute for it.
 *
 * Missing ANY of --execute/--confirm-name/--backup-reference/
 * --second-approver, or a --confirm-name that does not exactly match the
 * company's on-file name, refuses to delete anything and explains exactly
 * what's missing/mismatched.
 *
 * What actually gets deleted, and how:
 *
 *   - Every one of the 34 tables in COMPANY_SCOPED_TABLES (scripts/lib/
 *     companyScopedTables.ts) already has `company_id uuid not null
 *     references public.companies (id) on delete cascade` - verified
 *     directly against supabase/migrations/*.sql, not assumed (see that
 *     file's own docblock). Deleting the `companies` row therefore cascades
 *     all 34 tables at the database level; this script does not issue 34
 *     separate DELETE statements.
 *   - Storage objects (the vendor-documents bucket, under
 *     company/<companyId>/) are NEVER a database-level cascade, so this
 *     script explicitly deletes them itself, before deleting the companies
 *     row.
 *
 * What is deliberately NEVER deleted: `auth.users` rows. A person's login
 * identity may span companies (the same email invited to two different
 * companies) or predate this one in ways this script has no way to know it
 * fully understands - company_members rows referencing a user are deleted
 * (cascaded via company_id, same as every other table), but the user's
 * actual auth.users row is left untouched. If an operator also needs to
 * remove a user's login entirely, that is a separate, deliberate action
 * outside this script's scope.
 *
 * Usage:
 *   bun scripts/delete-company.ts <companyId>                          # dry run (default)
 *   bun scripts/delete-company.ts <companyId> --dry-run                # dry run (explicit)
 *   bun scripts/delete-company.ts <companyId> --execute \
 *     --confirm-name="Acme Construction LLC" \
 *     --backup-reference="pitr-2026-09-17T00:00:00Z" \
 *     --second-approver="jane.doe@vendorclr.com"
 *
 * Requires VENDORCLEAR_SUPABASE_URL and VENDORCLEAR_SERVICE_ROLE_KEY (see
 * .env.example), same as export-company.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { countCompanyRows, fetchCompanyName, type TableRowCount } from "./lib/companyLookup";
import { companyStoragePrefix, VENDOR_DOCUMENTS_BUCKET } from "./lib/companyScopedTables";
import { getAdminClient } from "./lib/supabaseAdminClient";
import { listCompanyStorageObjects, type StorageObjectListing } from "./export-company";

export interface ParsedDeleteArgs {
  companyId: string;
  execute: boolean;
  confirmName: string | null;
  backupReference: string | null;
  secondApprover: string | null;
}

export interface ArgParseError {
  error: string;
}

/** Pure CLI-arg parsing, no I/O - independently testable and reused by main(). */
export function parseDeleteArgs(argv: string[]): ParsedDeleteArgs | ArgParseError {
  const [companyId, ...rest] = argv;
  if (!companyId) {
    return {
      error:
        "Usage: bun scripts/delete-company.ts <companyId> [--dry-run | --execute --confirm-name=<name> --backup-reference=<ref> --second-approver=<name>]",
    };
  }

  let execute = false;
  let confirmName: string | null = null;
  let backupReference: string | null = null;
  let secondApprover: string | null = null;

  for (const arg of rest) {
    if (arg === "--dry-run") continue; // the default; accepted explicitly for clarity in runbooks/scripts
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex === -1) {
      return { error: `Unrecognized argument: ${arg}` };
    }
    const flag = arg.slice(0, eqIndex);
    const value = arg.slice(eqIndex + 1);
    if (flag === "--confirm-name") confirmName = value;
    else if (flag === "--backup-reference") backupReference = value;
    else if (flag === "--second-approver") secondApprover = value;
    else return { error: `Unrecognized argument: ${flag}` };
  }

  return { companyId, execute, confirmName, backupReference, secondApprover };
}

export interface AuthorizationFailure {
  authorized: false;
  reasons: string[];
}
export interface AuthorizationSuccess {
  authorized: true;
}

/**
 * The load-bearing gate: given the parsed args and the company's actual
 * on-file name, decides whether a destructive delete may proceed. Returns
 * every unmet requirement at once (not just the first) so an operator fixing
 * a rejected invocation sees the whole list in one pass.
 */
export function assertDeletionAuthorized(
  args: ParsedDeleteArgs,
  actualCompanyName: string,
): AuthorizationFailure | AuthorizationSuccess {
  const reasons: string[] = [];
  if (!args.execute) reasons.push("--execute was not passed (this would be a dry run).");
  if (!args.confirmName) reasons.push("--confirm-name=<exact company name> is required.");
  else if (args.confirmName !== actualCompanyName) {
    reasons.push(
      `--confirm-name "${args.confirmName}" does not exactly match the company's on-file name "${actualCompanyName}".`,
    );
  }
  if (!args.backupReference) reasons.push("--backup-reference=<backup id/timestamp> is required.");
  if (!args.secondApprover) reasons.push("--second-approver=<name/id/email> is required.");

  return reasons.length > 0 ? { authorized: false, reasons } : { authorized: true };
}

export interface DeletionPlan {
  companyId: string;
  companyName: string;
  tables: TableRowCount[];
  storage: { bucket: string; objectCount: number; totalBytes: number };
}

/** Builds the dry-run report - identical shape/content whether or not the caller goes on to actually delete. */
export async function planDeletion(
  supabase: SupabaseClient,
  companyId: string,
  companyName: string,
): Promise<DeletionPlan> {
  const tables = await countCompanyRows(supabase, companyId);
  const storageObjects = await listCompanyStorageObjects(
    supabase,
    VENDOR_DOCUMENTS_BUCKET,
    companyStoragePrefix(companyId),
  );
  return {
    companyId,
    companyName,
    tables,
    storage: {
      bucket: VENDOR_DOCUMENTS_BUCKET,
      objectCount: storageObjects.length,
      totalBytes: storageObjects.reduce((sum, o) => sum + o.size, 0),
    },
  };
}

function printPlan(plan: DeletionPlan, heading: string): void {
  console.log(`\n${heading}`);
  console.log(`Company: ${plan.companyName} (${plan.companyId})\n`);
  let totalRows = 0;
  for (const { table, rowCount } of plan.tables) {
    console.log(`  ${table}: ${rowCount} row(s)`);
    totalRows += rowCount;
  }
  console.log(`  --------------------------------`);
  console.log(`  TOTAL: ${totalRows} row(s) across ${plan.tables.length} tables`);
  console.log(
    `\n  Storage (${plan.storage.bucket}): ${plan.storage.objectCount} object(s), ${plan.storage.totalBytes} byte(s)`,
  );
  console.log(
    `\n  The companies row itself cascades (on delete cascade) to every table listed above.` +
      ` auth.users rows are never deleted by this script.`,
  );
}

// Same page size as listCompanyStorageObjects()'s own list() pagination
// (export-company.ts) - that function already established that a single
// company can plausibly have well over 1000 documents (many vendors, each
// with years of certificates). A single unchunked remove() call carrying
// every path at once risks hitting a request-size/timeout limit on the
// Storage API for exactly the largest, most-in-need-of-this-tool companies.
// Chunking here mirrors the scale-awareness the list side already has.
const REMOVE_CHUNK_SIZE = 1000;

/** Deletes every storage object this company owns, chunked (see REMOVE_CHUNK_SIZE) so a very large company doesn't send one oversized batch request. Continues through remaining chunks even if one fails, aggregating every chunk's error and throwing once at the end - so a partial failure is fully visible (which paths failed) rather than silently stopping partway through and leaving the rest never attempted. */
async function deleteStorageObjects(
  supabase: SupabaseClient,
  objects: StorageObjectListing[],
): Promise<void> {
  if (objects.length === 0) return;

  const errors: string[] = [];
  for (let i = 0; i < objects.length; i += REMOVE_CHUNK_SIZE) {
    const chunk = objects.slice(i, i + REMOVE_CHUNK_SIZE);
    const paths = chunk.map((o) => o.path);
    // Supabase Storage's remove() accepts a batch of paths in one call.
    const { error } = await supabase.storage.from(VENDOR_DOCUMENTS_BUCKET).remove(paths);
    if (error) {
      errors.push(
        `paths ${i}-${i + chunk.length - 1} (${chunk.length} object(s)): ${error.message}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Failed to delete storage objects in ${errors.length} chunk(s):\n${errors.join("\n")}`,
    );
  }
}

/**
 * The actual deletion. Storage objects first (never DB-cascaded, and
 * deleting them after the DB row would leave no record of which paths to
 * clean up), then the companies row itself, which cascades every table in
 * COMPANY_SCOPED_TABLES.
 */
export async function executeDeletion(
  supabase: SupabaseClient,
  companyId: string,
  storageObjects: StorageObjectListing[],
): Promise<void> {
  await deleteStorageObjects(supabase, storageObjects);
  const { error } = await supabase.from("companies").delete().eq("id", companyId);
  if (error) throw new Error(`Failed to delete company ${companyId}: ${error.message}`);
}

async function main(): Promise<void> {
  const parsed = parseDeleteArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const supabase = getAdminClient();
  const companyName = await fetchCompanyName(supabase, parsed.companyId);
  if (companyName === null) {
    console.error(`No company found with id ${parsed.companyId}. Nothing to delete.`);
    process.exitCode = 1;
    return;
  }

  const plan = await planDeletion(supabase, parsed.companyId, companyName);

  if (!parsed.execute) {
    printPlan(plan, "DRY RUN - nothing will be deleted.");
    console.log(
      "\nTo actually delete, re-run with --execute --confirm-name=<exact name> " +
        "--backup-reference=<ref> --second-approver=<name>.",
    );
    return;
  }

  const authorization = assertDeletionAuthorized(parsed, companyName);
  if (!authorization.authorized) {
    console.error("Refusing to delete. Unmet requirements:");
    for (const reason of authorization.reasons) console.error(`  - ${reason}`);
    process.exitCode = 1;
    return;
  }

  printPlan(plan, "DELETING - the following will be permanently removed:");
  console.log(`\nBackup reference on record: ${parsed.backupReference}`);
  console.log(`Second approver on record: ${parsed.secondApprover}`);

  const storageObjects = await listCompanyStorageObjects(
    supabase,
    VENDOR_DOCUMENTS_BUCKET,
    companyStoragePrefix(parsed.companyId),
  );
  await executeDeletion(supabase, parsed.companyId, storageObjects);

  console.log(`\nDeleted company ${companyName} (${parsed.companyId}) and all associated data.`);
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("delete-company.ts");
if (isDirectRun) {
  main().catch((error) => {
    console.error("delete-company failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
