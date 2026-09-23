import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  REPORT_DEFINITIONS,
  REPORT_KINDS,
  summarizeComplianceBy,
  type ReportColumn,
  type ReportKind,
  type ReportRow,
} from "./reportCatalog";

/**
 * Task 11b - server-side CSV export generation, originally wired to two
 * report shapes (the point-in-time audit report and open deficiencies).
 * Since the pilot-blockers Reports UI, every report in reportCatalog.ts is
 * exportable through the same handler: loadReportRows() below maps each
 * catalog kind onto its existing reportRepository.ts read, and the CSV uses
 * the catalog's column list so the file matches the on-screen table.
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

// Spreadsheet software (Excel, Google Sheets, LibreOffice) evaluates a cell as
// a formula when its text begins with one of these - so an exported cell like
// `=HYPERLINK(...)`, `+cmd`, `-2+3` or `@SUM(...)` runs on open. These exports
// (and the rejected-rows import echo) carry user/vendor-entered text such as
// vendor and contact names, emails and addresses, which is exactly the kind of
// attacker-influenced data that must not be handed to a formula engine.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvEscapeField(value: unknown): string {
  let str = value === null || value === undefined ? "" : String(value);
  // Only string cells are attacker-controlled; a real number our own code
  // produces (durations, counts) is never a formula, so neutralizing it would
  // needlessly corrupt a legitimate negative value in a numeric column.
  if (typeof value === "string" && FORMULA_TRIGGER.test(str)) {
    str = `'${str}`;
  }
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
  reportKind: z.enum(["audit_snapshot", ...REPORT_KINDS]),
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

  const definition = REPORT_DEFINITIONS[data.reportKind];
  const rows = await loadReportRows(data.reportKind, data.companyId);
  return {
    csv: reportTableToCsv(definition.columns, rows),
    reportName: definition.fileSlug,
    targetType: "company",
    targetId: data.companyId,
    rowCount: rows.length,
  };
}

/** CSV for a catalog report - the same column list the Reports page renders, in the same order. */
export function reportTableToCsv(columns: ReportColumn[], rows: ReportRow[]): string {
  return rowsToCsv(
    rows,
    columns.map((c) => ({ key: c.key, header: c.header })),
  );
}

/**
 * Loads one catalog report's rows through the existing Task 11b report
 * reads (reportRepository.ts - request-scoped client, RLS-scoped to the
 * caller's company) and flattens them to the catalog's column keys. No
 * report SQL lives here; each branch is a direct call to the matching
 * repository function.
 */
export async function loadReportRows(kind: ReportKind, companyId: string): Promise<ReportRow[]> {
  const repo = await import("@/data/repositories/reportRepository");
  const yesNo = (value: boolean) => (value ? "Yes" : "No");

  switch (kind) {
    case "compliance_by_project":
    case "compliance_by_trade":
      return summarizeComplianceBy(
        await repo.getAssignmentComplianceRows(companyId),
        kind === "compliance_by_project" ? "project" : "trade",
      );
    case "expiring_30":
    case "expiring_60":
    case "expiring_90": {
      const window = kind === "expiring_30" ? 30 : kind === "expiring_60" ? 60 : 90;
      const rows = await repo.getExpiryReport(companyId, window);
      return rows
        .map((r) => ({
          vendorName: r.vendorName,
          policyType: r.policyType,
          expirationDate: r.expirationDate,
          projectName: r.projectName,
          policyId: r.policyId,
        }))
        .sort((a, b) => a.expirationDate.localeCompare(b.expirationDate));
    }
    case "missing_evidence":
    case "open_deficiencies": {
      const rows =
        kind === "missing_evidence"
          ? await repo.getMissingDocumentationReport(companyId)
          : await repo.getOpenDeficienciesReport(companyId);
      return rows.map((r) => ({
        vendorName: r.vendorName,
        projectName: r.projectName,
        requirementKey: r.requirementKey,
        kind: r.kind,
        policyType: r.policyType,
        explanation: r.explanation,
        deficiencyId: r.deficiencyId,
      }));
    }
    case "active_exceptions":
      return (await repo.getExceptionsReport(companyId))
        .filter((r) => r.isActive)
        .map((r) => ({
          vendorName: r.vendorName,
          projectName: r.projectName,
          requirementKey: r.requirementKey,
          reason: r.reason,
          effectiveOn: r.effectiveOn,
          expiresOn: r.expiresOn,
          exceptionId: r.exceptionId,
        }));
    case "unresponsive_vendors":
      return (await repo.getUnresponsiveReport(companyId)).map((r) => ({
        vendorName: r.vendorName,
        signal:
          r.signal === "upload_request_expired"
            ? "Upload request expired"
            : "Correction request overdue",
        since: r.since,
      }));
    case "bounced_communications":
      return (await repo.getBouncedReport(companyId)).map((r) => ({
        vendorName: r.vendorName,
        toEmail: r.toEmail,
        eventType: r.eventType === "bounced" ? "Bounced" : "Marked as spam",
        occurredAt: r.occurredAt,
      }));
    case "time_to_compliance":
      return (await repo.getTimeToComplianceReport(companyId)).map((r) => ({
        vendorName: r.vendorName,
        requirementKey: r.requirementKey,
        firstEvaluatedAt: r.firstEvaluatedAt,
        resolvedAt: r.resolvedAt,
        durationHours: r.durationHours,
      }));
    case "resubmissions":
      return (await repo.getResubmissionsReport(companyId)).map((r) => ({
        vendorName: r.vendorName,
        projectName: r.projectName,
        evaluationRunCount: r.evaluationRunCount,
        hasResubmission: yesNo(r.hasResubmission),
      }));
    case "reviewer_turnaround":
      return (await repo.getReviewerTurnaroundReport(companyId)).map((r) => ({
        vendorName: r.vendorName,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        durationHours: r.durationHours,
      }));
  }
}

// ---------------------------------------------------------------------------
// getReportRows - the on-screen read. Same explicit membership check as the
// export, so viewing and exporting a report are gated identically.
// ---------------------------------------------------------------------------

const getReportRowsSchema = z.object({
  companyId: z.string().uuid(),
  reportKind: z.enum(REPORT_KINDS),
});

export interface ReportRowsView {
  reportKind: ReportKind;
  rows: ReportRow[];
}

export async function getReportRowsHandler(
  supabase: SupabaseClient,
  data: z.infer<typeof getReportRowsSchema>,
  loadRowsFn: (kind: ReportKind, companyId: string) => Promise<ReportRow[]> = loadReportRows,
): Promise<ReportRowsView> {
  await assertCompanyMember(supabase, data.companyId);
  return { reportKind: data.reportKind, rows: await loadRowsFn(data.reportKind, data.companyId) };
}

export const getReportRows = createServerFn({ method: "POST" })
  .validator(getReportRowsSchema)
  .handler(async ({ data }): Promise<ReportRowsView> => {
    const supabase = await getRequestScopedClient();
    return getReportRowsHandler(supabase, data);
  });

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
