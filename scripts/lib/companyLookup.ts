/**
 * Task 12 - shared by export-company.ts and delete-company.ts: looks up a
 * company's on-file name and per-table row counts. Row counts (not full
 * rows) are what delete-company.ts's dry-run report needs; export-company.ts
 * separately reads full rows via exportCompanyTables() in export-company.ts
 * itself, since it needs the data, not just a count.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { COMPANY_SCOPED_TABLES, type CompanyScopedTable } from "./companyScopedTables";

/** Looks up the company's on-file name. Returns null if the id does not exist - callers decide whether that's fatal. */
export async function fetchCompanyName(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("companies")
    .select("name")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up company ${companyId}: ${error.message}`);
  return (data as { name: string } | null)?.name ?? null;
}

export interface TableRowCount {
  table: CompanyScopedTable;
  rowCount: number;
}

/**
 * COUNT-only pass over every company-scoped table (head: true, count:
 * "exact" - no rows transferred), for delete-company.ts's dry-run report.
 * Uses the exact same COMPANY_SCOPED_TABLES list export-company.ts reads
 * full rows from, so the two scripts can never report a different set of
 * tables for the same company.
 */
export async function countCompanyRows(
  supabase: SupabaseClient,
  companyId: string,
): Promise<TableRowCount[]> {
  const results: TableRowCount[] = [];
  for (const table of COMPANY_SCOPED_TABLES) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { head: true, count: "exact" })
      .eq("company_id", companyId);
    if (error) throw new Error(`Failed to count table "${table}": ${error.message}`);
    results.push({ table, rowCount: count ?? 0 });
  }
  return results;
}
