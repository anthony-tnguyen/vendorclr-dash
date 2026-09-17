import type { AuditSnapshotRow } from "@/data/repositories/reportRepository";

/**
 * Task 11b - renders report rows from an EXISTING audit_snapshots row
 * (20260917001600_reporting_audit_snapshots.sql). This is the "then renders
 * CSV/PDF from that snapshot" half of the plan's point-in-time audit report
 * bullet - see create_audit_snapshot() for the "first writes an immutable
 * snapshot" half.
 *
 * The single load-bearing property of every function in this file: NEVER
 * re-query live data. Everything rendered here comes only from the frozen
 * requirements_snapshot/evidence_snapshot jsonb columns already stored on
 * the AuditSnapshotRow passed in - a report generated from a snapshot taken
 * yesterday must still show yesterday's numbers today, even if the vendor's
 * coverage/deficiencies/exceptions have since changed.
 */

interface SnapshotRequirement {
  key: string;
  policy_type: string | null;
  kind: string;
  required: boolean;
  amount: number | null;
  source: string;
  configuration: Record<string, unknown> | null;
}

interface SnapshotPolicy {
  id: string;
  policy_type: string;
  carrier_name: string;
  policy_number: string;
  expiration_date: string | null;
  status: string;
}

interface SnapshotDeficiency {
  id: string;
  requirement_key: string;
  status: string;
  kind: string | null;
  explanation: string;
  resolved_at: string | null;
}

interface SnapshotException {
  id: string;
  deficiency_id: string;
  reason: string;
  effective_on: string;
  expires_on: string;
  reopened_at: string | null;
}

interface EvidenceSnapshot {
  policies: SnapshotPolicy[];
  deficiencies: SnapshotDeficiency[];
  exceptions: SnapshotException[];
}

export interface AuditSnapshotReportRow {
  section: "requirement" | "policy" | "deficiency" | "exception";
  key: string;
  status: string;
  detail: string;
}

/**
 * Flattens a snapshot's three frozen sections (requirements, evidence's
 * policies/deficiencies/exceptions) into one exportable row list - the shape
 * reportExports.ts's generic CSV writer consumes. Column order is stable and
 * documented by AuditSnapshotReportRow's own field order.
 */
export function renderAuditSnapshotReport(snapshot: AuditSnapshotRow): AuditSnapshotReportRow[] {
  const requirements = (snapshot.requirements_snapshot as SnapshotRequirement[] | null) ?? [];
  const evidence = (snapshot.evidence_snapshot as EvidenceSnapshot | null) ?? {
    policies: [],
    deficiencies: [],
    exceptions: [],
  };

  const rows: AuditSnapshotReportRow[] = [];

  for (const r of requirements) {
    rows.push({
      section: "requirement",
      key: r.key,
      status: r.required ? "required" : "not_required",
      detail: `${r.policy_type ?? r.kind} via ${r.source}${r.amount !== null ? ` ($${r.amount})` : ""}`,
    });
  }

  for (const p of evidence.policies ?? []) {
    rows.push({
      section: "policy",
      key: p.policy_type,
      status: p.status,
      detail: `${p.carrier_name || "Unknown carrier"} #${p.policy_number || "n/a"}, expires ${
        p.expiration_date ?? "n/a"
      }`,
    });
  }

  for (const d of evidence.deficiencies ?? []) {
    rows.push({
      section: "deficiency",
      key: d.requirement_key,
      status: d.status,
      detail: d.explanation,
    });
  }

  for (const e of evidence.exceptions ?? []) {
    rows.push({
      section: "exception",
      key: e.deficiency_id,
      status: e.reopened_at ? "expired_reopened" : "active",
      detail: `${e.reason} (effective ${e.effective_on} - ${e.expires_on})`,
    });
  }

  return rows;
}
