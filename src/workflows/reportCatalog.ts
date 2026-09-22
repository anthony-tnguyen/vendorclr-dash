/**
 * The customer-facing report catalog: one entry per report the Reports page
 * offers, naming its label, description and column set. Pure and isomorphic
 * (no server imports) so the page can render the picker and table headers,
 * and the server exporter (reportExports.ts) can build the CSV from the SAME
 * column list - the table on screen and the downloaded file cannot drift.
 *
 * Every report is backed by an existing read in
 * src/data/repositories/reportRepository.ts (Task 11b); nothing here
 * re-implements report SQL. The only computation in this file is
 * summarizeComplianceBy(), a TypeScript rollup over getAssignmentComplianceRows().
 */

export const REPORT_KINDS = [
  "compliance_by_project",
  "compliance_by_trade",
  "expiring_30",
  "expiring_60",
  "expiring_90",
  "missing_evidence",
  "open_deficiencies",
  "active_exceptions",
  "unresponsive_vendors",
  "bounced_communications",
  "time_to_compliance",
  "resubmissions",
  "reviewer_turnaround",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportColumn {
  key: string;
  header: string;
}

export interface ReportDefinition {
  kind: ReportKind;
  label: string;
  description: string;
  /** Used in the export filename, e.g. "Halstead-Builders-expiring-30-days-2026-09-22.csv". */
  fileSlug: string;
  columns: ReportColumn[];
}

const DEFICIENCY_COLUMNS: ReportColumn[] = [
  { key: "vendorName", header: "Vendor" },
  { key: "projectName", header: "Project" },
  { key: "requirementKey", header: "Requirement" },
  { key: "kind", header: "Kind" },
  { key: "policyType", header: "Policy type" },
  { key: "explanation", header: "Explanation" },
  { key: "deficiencyId", header: "Deficiency ID" },
];

const COMPLIANCE_ROLLUP_COLUMNS = (groupHeader: string): ReportColumn[] => [
  { key: "group", header: groupHeader },
  { key: "assignments", header: "Active assignments" },
  { key: "compliant", header: "Compliant" },
  { key: "nonCompliant", header: "With open deficiencies" },
  { key: "notEvaluated", header: "Not yet evaluated" },
  { key: "compliantPct", header: "Compliant %" },
  { key: "openDeficiencies", header: "Open deficiencies" },
];

const EXPIRY_COLUMNS: ReportColumn[] = [
  { key: "vendorName", header: "Vendor" },
  { key: "policyType", header: "Policy type" },
  { key: "expirationDate", header: "Expires" },
  { key: "projectName", header: "Project" },
  { key: "policyId", header: "Policy ID" },
];

export const REPORT_DEFINITIONS: Record<ReportKind, ReportDefinition> = {
  compliance_by_project: {
    kind: "compliance_by_project",
    label: "Compliance by project",
    description:
      "Active vendor assignments per project, split into compliant, with open deficiencies, and not yet evaluated.",
    fileSlug: "compliance-by-project",
    columns: COMPLIANCE_ROLLUP_COLUMNS("Project"),
  },
  compliance_by_trade: {
    kind: "compliance_by_trade",
    label: "Compliance by trade",
    description: "The same assignment-level compliance rollup, grouped by assignment trade.",
    fileSlug: "compliance-by-trade",
    columns: COMPLIANCE_ROLLUP_COLUMNS("Trade"),
  },
  expiring_30: {
    kind: "expiring_30",
    label: "Expiring in 30 days",
    description: "Active policies expiring within 30 days, with every project the vendor is on.",
    fileSlug: "expiring-30-days",
    columns: EXPIRY_COLUMNS,
  },
  expiring_60: {
    kind: "expiring_60",
    label: "Expiring in 60 days",
    description: "Active policies expiring within 60 days, with every project the vendor is on.",
    fileSlug: "expiring-60-days",
    columns: EXPIRY_COLUMNS,
  },
  expiring_90: {
    kind: "expiring_90",
    label: "Expiring in 90 days",
    description: "Active policies expiring within 90 days, with every project the vendor is on.",
    fileSlug: "expiring-90-days",
    columns: EXPIRY_COLUMNS,
  },
  missing_evidence: {
    kind: "missing_evidence",
    label: "Missing evidence",
    description:
      "Open document, limit and endorsement deficiencies with no evidence submitted at all.",
    fileSlug: "missing-evidence",
    columns: DEFICIENCY_COLUMNS,
  },
  open_deficiencies: {
    kind: "open_deficiencies",
    label: "Open deficiencies",
    description: "Every open deficiency, including evidence that was submitted but falls short.",
    fileSlug: "open-deficiencies",
    columns: DEFICIENCY_COLUMNS,
  },
  active_exceptions: {
    kind: "active_exceptions",
    label: "Active exceptions",
    description: "Approved exceptions that have not expired or been reopened.",
    fileSlug: "active-exceptions",
    columns: [
      { key: "vendorName", header: "Vendor" },
      { key: "projectName", header: "Project" },
      { key: "requirementKey", header: "Requirement" },
      { key: "reason", header: "Reason" },
      { key: "effectiveOn", header: "Effective" },
      { key: "expiresOn", header: "Expires" },
      { key: "exceptionId", header: "Exception ID" },
    ],
  },
  unresponsive_vendors: {
    kind: "unresponsive_vendors",
    label: "Unresponsive vendors",
    description:
      "Vendors with an upload request past its deadline, or a correction request overdue at the 14-day escalation level.",
    fileSlug: "unresponsive-vendors",
    columns: [
      { key: "vendorName", header: "Vendor" },
      { key: "signal", header: "Signal" },
      { key: "since", header: "Since" },
    ],
  },
  bounced_communications: {
    kind: "bounced_communications",
    label: "Bounced communications",
    description: "Emails that bounced or were marked as spam by the recipient.",
    fileSlug: "bounced-communications",
    columns: [
      { key: "vendorName", header: "Vendor" },
      { key: "toEmail", header: "Recipient" },
      { key: "eventType", header: "Event" },
      { key: "occurredAt", header: "Occurred" },
    ],
  },
  time_to_compliance: {
    kind: "time_to_compliance",
    label: "Time to compliance",
    description: "Hours from a deficiency's first evaluation to its resolution.",
    fileSlug: "time-to-compliance",
    columns: [
      { key: "vendorName", header: "Vendor" },
      { key: "requirementKey", header: "Requirement" },
      { key: "firstEvaluatedAt", header: "First evaluated" },
      { key: "resolvedAt", header: "Resolved" },
      { key: "durationHours", header: "Hours" },
    ],
  },
  resubmissions: {
    kind: "resubmissions",
    label: "Resubmissions",
    description: "Evaluation runs per compliance case; more than one means the vendor resubmitted.",
    fileSlug: "resubmissions",
    columns: [
      { key: "vendorName", header: "Vendor" },
      { key: "projectName", header: "Project" },
      { key: "evaluationRunCount", header: "Evaluation runs" },
      { key: "hasResubmission", header: "Resubmitted" },
    ],
  },
  reviewer_turnaround: {
    kind: "reviewer_turnaround",
    label: "Reviewer turnaround",
    description: "Hours from a document entering manual review to the reviewer's decision.",
    fileSlug: "reviewer-turnaround",
    columns: [
      { key: "vendorName", header: "Vendor" },
      { key: "createdAt", header: "Entered review" },
      { key: "resolvedAt", header: "Decided" },
      { key: "durationHours", header: "Hours" },
    ],
  },
};

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Compliance rollup
// ---------------------------------------------------------------------------

export interface AssignmentComplianceInput {
  projectName: string;
  tradeCode: string | null;
  assignmentStatus: string;
  evaluated: boolean;
  openDeficiencyCount: number;
}

export interface ComplianceRollupRow extends ReportRow {
  group: string;
  assignments: number;
  compliant: number;
  nonCompliant: number;
  notEvaluated: number;
  /** Compliant share of EVALUATED assignments, or null when none have been evaluated yet. */
  compliantPct: number | null;
  openDeficiencies: number;
}

/**
 * Groups ACTIVE assignments (completed/terminated ones are no longer on the
 * hook) by project or trade. An assignment is compliant when it has been
 * evaluated and has no open deficiency; it is "not yet evaluated" when no
 * compliance case exists for it. The percentage is taken over evaluated
 * assignments only, so an unevaluated roster never reads as 100% compliant.
 */
export function summarizeComplianceBy(
  rows: AssignmentComplianceInput[],
  by: "project" | "trade",
): ComplianceRollupRow[] {
  const groups = new Map<string, ComplianceRollupRow>();
  for (const row of rows) {
    if (row.assignmentStatus !== "active") continue;
    const group = by === "project" ? row.projectName : (row.tradeCode ?? "No trade set");
    const current = groups.get(group) ?? {
      group,
      assignments: 0,
      compliant: 0,
      nonCompliant: 0,
      notEvaluated: 0,
      compliantPct: null,
      openDeficiencies: 0,
    };
    current.assignments += 1;
    current.openDeficiencies += row.openDeficiencyCount;
    if (!row.evaluated) current.notEvaluated += 1;
    else if (row.openDeficiencyCount > 0) current.nonCompliant += 1;
    else current.compliant += 1;
    groups.set(group, current);
  }
  for (const g of groups.values()) {
    const evaluated = g.compliant + g.nonCompliant;
    g.compliantPct = evaluated === 0 ? null : Math.round((g.compliant / evaluated) * 100);
  }
  return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
}

/** Human-readable cell text for the on-screen table. The CSV keeps the raw value. */
export function formatReportCell(value: ReportCell): string {
  if (value === null || value === "") return "—";
  return String(value);
}
