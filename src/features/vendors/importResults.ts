import { rowsToCsv } from "@/workflows/reportExports";
import {
  EXPECTED_COLUMNS,
  type ExecuteResult,
  type ParsedRow,
  type RowResult,
} from "@/workflows/vendorImports";

/** Result shaping for the CSV import page (VendorImportPage.tsx). */

export interface Tallies {
  processed: number;
  accepted: number;
  projectsCreated: number;
  projectsMatched: number;
  vendorsCreated: number;
  vendorsMatched: number;
  assignmentsCreated: number;
  assignmentsMatched: number;
  skipped: number;
  rejectedAtWrite: number;
  requestsSent: number;
  requestFailures: number;
}

/** Row-level results -> the counts shown after an import. "Skipped" rows failed validation and were never attempted; "rejected at write" rows passed validation but the database refused them. */
export function tallyImport(result: ExecuteResult): Tallies {
  const t: Tallies = {
    processed: result.totalRows,
    accepted: result.acceptedRows,
    projectsCreated: 0,
    projectsMatched: 0,
    vendorsCreated: 0,
    vendorsMatched: 0,
    assignmentsCreated: 0,
    assignmentsMatched: 0,
    skipped: 0,
    rejectedAtWrite: 0,
    requestsSent: 0,
    requestFailures: 0,
  };
  for (const r of result.rowResults) {
    if (r.status === "rejected") {
      const writeFailure = (r.errors ?? []).some((e) => e.field === "row");
      if (writeFailure) t.rejectedAtWrite += 1;
      else t.skipped += 1;
      continue;
    }
    if (r.projectCreated) t.projectsCreated += 1;
    else t.projectsMatched += 1;
    if (r.vendorCreated) t.vendorsCreated += 1;
    else t.vendorsMatched += 1;
    if (r.assignmentCreated) t.assignmentsCreated += 1;
    else t.assignmentsMatched += 1;
    if (r.dispatch) {
      if (r.dispatch.status === "sent") t.requestsSent += 1;
      else if (r.dispatch.status === "failed" || r.dispatch.status === "error")
        t.requestFailures += 1;
    }
  }
  return t;
}

/** The original CSV columns for every row that was not imported, plus the reason - fix and re-upload. */
export function buildRejectedRowsCsv(rows: ParsedRow[], results: RowResult[]): string {
  const byNumber = new Map(rows.map((r) => [r.rowNumber, r]));
  const out = results
    .filter((r) => r.status === "rejected")
    .map((r) => {
      const source = byNumber.get(r.rowNumber);
      return {
        row_number: r.rowNumber,
        project_name: source?.projectName ?? "",
        certificate_holder_name: source?.certificateHolderName ?? "",
        certificate_holder_address: source?.certificateHolderAddress ?? "",
        vendor_name: source?.vendorName ?? "",
        trade: source?.trade ?? "",
        contact_name: source?.contactName ?? "",
        contact_email: source?.contactEmail ?? "",
        risk_tier: source?.riskTier ?? "",
        contract_value: source?.contractValue ?? "",
        dispatch_request: source?.dispatchRequest ? "true" : "false",
        errors: (r.errors ?? []).map((e) => `${e.field}: ${e.reason}`).join(" | "),
      };
    });
  const keys = ["row_number", ...EXPECTED_COLUMNS, "errors"] as const satisfies ReadonlyArray<
    keyof (typeof out)[number]
  >;
  return rowsToCsv(
    out,
    keys.map((key) => ({ key, header: key })),
  );
}
