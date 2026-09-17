#!/usr/bin/env node
/**
 * Task 12 - a standalone operations script, not application code, following
 * the same conventions as scripts/check-email-deliverability.ts: run by
 * hand (or from a documented runbook step - see docs/operations/
 * customer-export.md), never imported by anything in src/**, never run on a
 * schedule. Node-only APIs (node:fs/promises, node:path) are acceptable
 * here for the same reason they're acceptable in that file - this never
 * runs in the Cloudflare Workers request path.
 *
 * READ-ONLY. This script never deletes or modifies a row or a storage
 * object - it only reads from the live project (via the service-role
 * client, same as delete-company.ts) and writes local export files. See
 * docs/operations/customer-export.md for when to run this (a customer data
 * request, offboarding, a legal hold) and what the output looks like.
 *
 * Produces, under the given output directory:
 *
 *   manifest.json          - company id/name, export timestamp, and for
 *                             every table in COMPANY_SCOPED_TABLES (see
 *                             scripts/lib/companyScopedTables.ts) the row
 *                             count actually exported, plus the count and
 *                             total bytes of storage objects exported.
 *   tables/<table>.json     - one JSON file per table, an array of every row
 *                             (RLS-bypassing service-role read, filtered to
 *                             `company_id = <companyId>` in the query
 *                             itself, not just trusted from RLS) belonging
 *                             to this company.
 *   storage/<same path as in the bucket> - every object under
 *                             company/<companyId>/ in the vendor-documents
 *                             bucket, downloaded byte-for-byte with the same
 *                             relative path it has in the bucket.
 *
 * One combined JSON per table (rather than one giant combined file) was
 * chosen so a single huge table never forces loading the whole export into
 * memory/an editor at once to inspect one other table, and so
 * manifest.json itself stays small and fast to read for a row-count sanity
 * check - see docs/operations/customer-deletion.md's reconciliation step,
 * which compares this manifest's counts against post-deletion counts.
 *
 * Usage:
 *   bun scripts/export-company.ts <companyId> [outputDir]
 *
 *   companyId  - required. The companies.id (uuid) to export.
 *   outputDir  - optional. Defaults to ./exports/<companyId>-<timestamp>.
 *
 * Requires VENDORCLEAR_SUPABASE_URL and VENDORCLEAR_SERVICE_ROLE_KEY (see
 * .env.example) - the same service-role credentials the app's own
 * server-only code uses, pointed at whichever project (local/staging/
 * production) the operator intends to export from.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchCompanyName } from "./lib/companyLookup";
import {
  COMPANY_SCOPED_TABLES,
  companyStoragePrefix,
  VENDOR_DOCUMENTS_BUCKET,
  type CompanyScopedTable,
} from "./lib/companyScopedTables";
import { getAdminClient } from "./lib/supabaseAdminClient";

export { fetchCompanyName };

export interface TableExport {
  table: CompanyScopedTable;
  rowCount: number;
  rows: Record<string, unknown>[];
}

export interface StorageObjectListing {
  /** Full path within the bucket, e.g. "company/<id>/vendor/<id>/documents/<file>.pdf". */
  path: string;
  size: number;
}

export interface ExportManifest {
  companyId: string;
  companyName: string | null;
  generatedAt: string;
  tables: Array<{ table: CompanyScopedTable; rowCount: number }>;
  storage: { bucket: string; objectCount: number; totalBytes: number };
}

/**
 * Reads every row in every company-scoped table for this company, one
 * table at a time. Sequential (not Promise.all) on purpose - this is an
 * operator-run script against a live project, and 34 tables' worth of
 * concurrent full-table-for-one-tenant queries is unnecessary load to throw
 * at production at once for a script with no latency requirement.
 */
export async function exportCompanyTables(
  supabase: SupabaseClient,
  companyId: string,
): Promise<TableExport[]> {
  const results: TableExport[] = [];
  for (const table of COMPANY_SCOPED_TABLES) {
    const { data, error } = await supabase.from(table).select("*").eq("company_id", companyId);
    if (error) throw new Error(`Failed to export table "${table}": ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    results.push({ table, rowCount: rows.length, rows });
  }
  return results;
}

/**
 * Recursively lists every object under `prefix` in `bucket` - Supabase
 * Storage's list() is not recursive (it returns one directory level, with
 * subfolders as entries whose `id` is null), so this walks the
 * company/<id>/vendor/<id>/documents/ tree itself. Paginates within each
 * directory level in case a single vendor ever has more than one page of
 * documents.
 */
export async function listCompanyStorageObjects(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string,
): Promise<StorageObjectListing[]> {
  const results: StorageObjectListing[] = [];
  const pageSize = 1000;

  async function walk(dir: string): Promise<void> {
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .list(dir, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`Failed to list storage path "${dir}": ${error.message}`);
      const entries = data ?? [];
      for (const entry of entries) {
        const entryPath = `${dir}/${entry.name}`;
        // A folder placeholder entry has no id/metadata; a real object does.
        if (entry.id === null) {
          await walk(entryPath);
        } else {
          results.push({ path: entryPath, size: (entry.metadata?.["size"] as number) ?? 0 });
        }
      }
      if (entries.length < pageSize) break;
      offset += pageSize;
    }
  }

  await walk(prefix);
  return results;
}

export function buildManifest(
  companyId: string,
  companyName: string | null,
  tableExports: TableExport[],
  storageObjects: StorageObjectListing[],
): ExportManifest {
  return {
    companyId,
    companyName,
    generatedAt: new Date().toISOString(),
    tables: tableExports.map(({ table, rowCount }) => ({ table, rowCount })),
    storage: {
      bucket: VENDOR_DOCUMENTS_BUCKET,
      objectCount: storageObjects.length,
      totalBytes: storageObjects.reduce((sum, o) => sum + o.size, 0),
    },
  };
}

async function downloadStorageObjects(
  supabase: SupabaseClient,
  bucket: string,
  objects: StorageObjectListing[],
  outputDir: string,
): Promise<void> {
  for (const object of objects) {
    const { data, error } = await supabase.storage.from(bucket).download(object.path);
    if (error)
      throw new Error(`Failed to download storage object "${object.path}": ${error.message}`);
    const destPath = path.join(outputDir, "storage", object.path);
    await mkdir(path.dirname(destPath), { recursive: true });
    const bytes = new Uint8Array(await data.arrayBuffer());
    await writeFile(destPath, bytes);
  }
}

async function main(): Promise<void> {
  const [, , companyId, outputDirArg] = process.argv;
  if (!companyId) {
    console.error("Usage: bun scripts/export-company.ts <companyId> [outputDir]");
    process.exitCode = 1;
    return;
  }

  const outputDir =
    outputDirArg ??
    path.join("exports", `${companyId}-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  const supabase = getAdminClient();

  console.log(`Exporting company ${companyId} to ${outputDir}\n`);

  const companyName = await fetchCompanyName(supabase, companyId);
  if (companyName === null) {
    console.error(`No company found with id ${companyId}. Nothing exported.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Company: ${companyName} (${companyId})`);

  console.log(`Reading ${COMPANY_SCOPED_TABLES.length} tables...`);
  const tableExports = await exportCompanyTables(supabase, companyId);
  for (const { table, rowCount } of tableExports) {
    console.log(`  ${table}: ${rowCount} row(s)`);
  }

  console.log(`\nListing storage objects under ${companyStoragePrefix(companyId)}/...`);
  const storageObjects = await listCompanyStorageObjects(
    supabase,
    VENDOR_DOCUMENTS_BUCKET,
    companyStoragePrefix(companyId),
  );
  console.log(`  ${storageObjects.length} object(s) found`);

  await mkdir(path.join(outputDir, "tables"), { recursive: true });
  for (const { table, rows } of tableExports) {
    await writeFile(path.join(outputDir, "tables", `${table}.json`), JSON.stringify(rows, null, 2));
  }

  console.log(`\nDownloading ${storageObjects.length} storage object(s)...`);
  await downloadStorageObjects(supabase, VENDOR_DOCUMENTS_BUCKET, storageObjects, outputDir);

  const manifest = buildManifest(companyId, companyName, tableExports, storageObjects);
  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\nDone. Manifest written to ${path.join(outputDir, "manifest.json")}`);
}

// Only run main() when this file is executed directly (bun/node), not when
// imported by src/tests/data-lifecycle.test.ts for its exported functions.
const isDirectRun = process.argv[1] && process.argv[1].endsWith("export-company.ts");
if (isDirectRun) {
  main().catch((error) => {
    console.error("export-company failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
