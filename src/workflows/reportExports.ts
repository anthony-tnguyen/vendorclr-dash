import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Task 11b - server-side CSV export generation. Wired to at least two report
 * shapes (the plan's own explicit "point-in-time audit report" export, plus
 * getOpenDeficienciesReport() as a second, independently-computed report) to
 * prove the generic export path actually works against more than one shape,
 * per the plan's own instruction - not all ten reports need wiring here.
 *
 * PDF export is explicitly OUT OF SCOPE for this dispatch - see
 * supabase/README.md's Known compromises for the full reasoning (a real
 * server-side PDF renderer is a new dependency decision this brief does not
 * make). Hand-rolling a minimal PDF format would be worse than clearly
 * deferring it, so this file only ever produces CSV text.
 */

async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

// ---------------------------------------------------------------------------
// CSV generation - dependency-free, mirrors the escaping rules Task 11a's
// parseCsv() (src/workflows/vendorImports.ts) already reads: a field
// containing a comma, a double quote, or a newline (\n or \r) is wrapped in
// double quotes, with any embedded double quote doubled (RFC 4180). Writing
// is the inverse of Task 11a's parsing problem and strictly simpler (no
// state machine needed - each field is escaped independently).
// ---------------------------------------------------------------------------

const NEEDS_QUOTING = /[",\r\n]/;

export function csvEscapeField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (!NEEDS_QUOTING.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

export interface CsvColumn<T> {
  key: keyof T;
  header: string;
}

/** Builds CSV text (header row + one row per input row) from typed rows and an explicit column list - the column list also fixes column order, which iterating Object.keys() on an arbitrary row would not guarantee. */
export function rowsToCsv<T extends object>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => csvEscapeField(c.header)).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscapeField(row[c.key])).join(","));
  }
  // \r\n line endings - the RFC 4180 convention Task 11a's parseCsv() also
  // explicitly handles (both \n and \r\n), so a file this function writes
  // round-trips through that parser unchanged.
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Filename generation - explicit, descriptive, sanitized against
// path-unsafe characters. Never interpolates a caller-controlled string
// (company name, report name) directly into a filename without stripping.
// ---------------------------------------------------------------------------

/** Strips/replaces anything that is not a letter, digit, space, hyphen or underscore, then collapses whitespace to a single hyphen - safe for use as a filename component on every common filesystem, and immune to path traversal (no '/', '\', '..', or NUL survives). */
export function sanitizeFilenamePart(value: string): string {
  const cleaned = value.replace(/[^\w\s-]/g, "").trim();
  const collapsed = cleaned.replace(/\s+/g, "-");
  return collapsed.length > 0 ? collapsed : "export";
}

export function buildExportFilename(companyName: string, reportName: string, date: Date): string {
  const dateStr = date.toISOString().slice(0, 10);
  return `${sanitizeFilenamePart(companyName)}-${sanitizeFilenamePart(reportName)}-${dateStr}.csv`;
}

// ---------------------------------------------------------------------------
// exportReport - the createServerFn wrapper. Explicit permission check as
// the FIRST statement (the request-scoped client's RLS already enforces
// company_id scoping on every underlying report query, but the export
// ACTION itself gets its own explicit check too - this project's general
// "don't rely solely on RLS for anything that also has explicit business
// meaning" caution, the same discipline saveExtractionEdit()/resolveReviewItem()
// (documentReview.ts) apply via assertPlatformAdmin() before their own
// service-role writes, just checked against ordinary company membership
// here rather than platform-admin status since this action is NOT
// staff-only).
// ---------------------------------------------------------------------------

const exportReportSchema = z.object({
  companyId: z.string().uuid(),
  companyName: z.string().min(1),
  reportKind: z.enum(["audit_snapshot", "open_deficiencies"]),
  /** Required when reportKind === "audit_snapshot" - the existing snapshot to render from. */
  snapshotId: z.string().uuid().optional(),
});

export interface ExportReportResult {
  filename: string;
  csv: string;
  rowCount: number;
}

/** Explicit "is this caller a member of this company" check, independent of RLS - queries company_members directly rather than trusting that the caller's later report queries would simply come back empty for a non-member (they would, under RLS, but this action has its own business meaning - "you may export this company's data" - worth asserting on its own). */
async function assertCompanyMember(supabase: SupabaseClient, companyId: string): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const { data: membership, error } = await supabase
    .from("company_members")
    .select("id")
    .eq("company_id", companyId)
    .eq("user_id", user.id)
    .is("deactivated_at", null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!membership) throw new Error("Not authorized to export this company's data.");

  return user.id;
}

export interface ReportRowsResult {
  csv: string;
  reportName: string;
  targetType: string;
  targetId: string;
  rowCount: number;
}

/**
 * Default row-fetching/CSV-building implementation, one branch per wired
 * report kind. Separated from exportReportHandler() below as an injectable
 * dependency (`rowsProviderFn`, defaulting to this) - same "a bare function
 * takes its collaborators as parameters, so tests can substitute a fake one"
 * split as executeVendorImportHandler()'s own `dispatchFn` parameter
 * (vendorImports.ts): reportRepository.ts's functions always resolve their
 * own request-scoped client internally (the same convention every other
 * repository in this project follows - requirementRepository.ts/
 * complianceCaseRepository.ts have no client-injection seam either, and are
 * proven correct at the SQL/RLS layer via PGlite instead, see
 * supabase/tests/reports.test.ts), so a unit test of exportReportHandler()'s
 * OWN logic (permission check, filename/CSV building, the audit_log write)
 * substitutes a fake `rowsProviderFn` rather than trying to mock PostgREST
 * itself.
 */
async function defaultRowsProvider(
  data: z.infer<typeof exportReportSchema>,
): Promise<ReportRowsResult> {
  if (data.reportKind === "audit_snapshot") {
    if (!data.snapshotId) {
      throw new Error("snapshotId is required to export the point-in-time audit report.");
    }
    const { getAuditSnapshot } = await import("@/data/repositories/reportRepository");
    const { renderAuditSnapshotReport } = await import("@/workflows/auditSnapshots");

    const snapshot = await getAuditSnapshot(data.snapshotId);
    if (!snapshot || snapshot.company_id !== data.companyId) {
      throw new Error("Snapshot not found.");
    }

    const rows = renderAuditSnapshotReport(snapshot);
    return {
      csv: rowsToCsv(rows, [
        { key: "section", header: "Section" },
        { key: "key", header: "Key" },
        { key: "status", header: "Status" },
        { key: "detail", header: "Detail" },
      ]),
      reportName: "audit-snapshot",
      targetType: "audit_snapshot",
      targetId: data.snapshotId,
      rowCount: rows.length,
    };
  }

  const { getOpenDeficienciesReport } = await import("@/data/repositories/reportRepository");
  const rows = await getOpenDeficienciesReport(data.companyId);
  return {
    csv: rowsToCsv(rows, [
      { key: "deficiencyId", header: "Deficiency ID" },
      { key: "requirementKey", header: "Requirement" },
      { key: "kind", header: "Kind" },
      { key: "policyType", header: "Policy Type" },
      { key: "vendorName", header: "Vendor" },
      { key: "projectName", header: "Project" },
      { key: "explanation", header: "Explanation" },
    ]),
    reportName: "open-deficiencies",
    targetType: "company",
    targetId: data.companyId,
    rowCount: rows.length,
  };
}

/**
 * The actual logic, taking the SupabaseClient (and, for tests, the
 * row-provider function) explicitly rather than resolving them itself -
 * same testability split as validateVendorImportRowsHandler()/
 * executeVendorImportHandler() (vendorImports.ts): createServerFn's
 * dispatch needs a "Start context" a plain test environment does not
 * establish, so the testable core lives in a bare function and the
 * createServerFn wrapper below is a thin pass-through.
 */
export async function exportReportHandler(
  supabase: SupabaseClient,
  data: z.infer<typeof exportReportSchema>,
  rowsProviderFn: (
    data: z.infer<typeof exportReportSchema>,
  ) => Promise<ReportRowsResult> = defaultRowsProvider,
): Promise<ExportReportResult> {
  const actorId = await assertCompanyMember(supabase, data.companyId);

  const { csv, reportName, targetType, targetId, rowCount } = await rowsProviderFn(data);

  const filename = buildExportFilename(data.companyName, reportName, new Date());

  const { error: auditError } = await supabase.from("audit_log").insert({
    company_id: data.companyId,
    actor_id: actorId,
    action: "report_exported",
    target_type: targetType,
    target_id: targetId,
    detail: { reportKind: data.reportKind, filename, rowCount },
  });
  if (auditError) throw new Error(auditError.message);

  const { logOperational, newRequestId } = await import("@/lib/observability/logger.server");
  logOperational({
    level: "info",
    event: "pilot_metric.report_exported",
    requestId: newRequestId(),
    companyId: data.companyId,
    outcome: "success",
  });

  return { filename, csv, rowCount };
}

export const exportReport = createServerFn({ method: "POST" })
  .validator(exportReportSchema)
  .handler(async ({ data }): Promise<ExportReportResult> => {
    const supabase = await getRequestScopedClient();
    return exportReportHandler(supabase, data);
  });
