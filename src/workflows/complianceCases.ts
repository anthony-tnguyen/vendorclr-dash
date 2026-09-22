import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  listCasesForAssignment,
  listCasesForVendor,
  listDeficienciesForCase,
  listEvaluationRunsForCase,
  listExceptionsForDeficiency,
  requestDeficiencyCorrection,
  approveComplianceException,
} from "@/data/repositories/complianceCaseRepository";
import type {
  ComplianceCaseRow,
  ComplianceDeficiencyRow,
  ComplianceEvaluationRunRow,
  ComplianceExceptionRow,
  PolicyType,
} from "@/data/dbTypeAliases";
import type { PolicyKind } from "@/domain/construction/types";
import type { ComplianceExceptionInput } from "@/domain/compliance/cases";

/**
 * Customer-facing read/write surface for the compliance-case workflow
 * (Task 10a/10b backend: 20260917001200 + 20260917001300). Every function
 * here is a thin wrapper over the existing repositories/RPCs - the engine
 * itself is never reimplemented in TypeScript.
 *
 * Reads run on the request-scoped client, so RLS decides visibility exactly
 * as elsewhere. Writes go through the schema's SECURITY DEFINER RPCs, which
 * enforce their own role checks (exception approval: owner/risk_manager
 * only) - nothing here widens or re-checks them.
 */

async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

/** JSON-safe shape for the deficiency's expected/observed jsonb over the wire. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface DeficiencyView {
  id: string;
  requirementKey: string;
  kind: PolicyKind | null;
  policyType: PolicyType | null;
  /** jsonb - narrow with requiredVsSubmitted()/generateCorrectionInstruction(). */
  expected: { [key: string]: JsonValue };
  observed: { [key: string]: JsonValue } | null;
  explanation: string;
  evidenceDocumentIds: string[];
  status: ComplianceDeficiencyRow["status"];
  firstDetectedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  correctionRequestedAt: string | null;
  escalationLevel: number;
  lastEscalatedAt: string | null;
  /** Latest evaluation run applied to this deficiency (evaluated_at + package). */
  latestEvaluation: { evaluatedAt: string; packageId: string } | null;
  /** Newest exception first; the active one is whichever the deficiency points at. */
  exceptions: Array<{
    id: string;
    reason: string;
    effectiveOn: string;
    expiresOn: string;
    vendorVisible: boolean;
    remainingRiskAcknowledged: boolean;
    approvedBy: string;
    approvedAt: string;
    reopenedAt: string | null;
    supportingDocumentId: string | null;
  }>;
}

export interface EvaluationRunView {
  id: string;
  packageId: string;
  evaluatedAt: string;
}

export interface ComplianceCaseView {
  caseId: string;
  assignmentId: string;
  vendorId: string;
  projectName: string;
  openedAt: string;
  updatedAt: string;
  uploadRequestId: string;
  deficiencies: DeficiencyView[];
  evaluationRuns: EvaluationRunView[];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toDeficiencyView(
  row: ComplianceDeficiencyRow,
  runs: ComplianceEvaluationRunRow[],
  exceptions: ComplianceExceptionRow[],
): DeficiencyView {
  const latestRun = runs.find((r) => r.id === row.last_evaluation_run_id) ?? null;
  return {
    id: row.id,
    requirementKey: row.requirement_key,
    kind: row.kind,
    policyType: row.policy_type,
    expected: asObject(row.expected) as { [key: string]: JsonValue },
    observed:
      row.observed === null ? null : (asObject(row.observed) as { [key: string]: JsonValue }),
    explanation: row.explanation,
    evidenceDocumentIds: row.evidence_document_ids ?? [],
    status: row.status,
    firstDetectedAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    correctionRequestedAt: row.correction_requested_at,
    escalationLevel: row.escalation_level,
    lastEscalatedAt: row.last_escalated_at,
    latestEvaluation: latestRun
      ? { evaluatedAt: latestRun.evaluated_at, packageId: latestRun.package_id }
      : null,
    exceptions: exceptions.map((e) => ({
      id: e.id,
      reason: e.reason,
      effectiveOn: e.effective_on,
      expiresOn: e.expires_on,
      vendorVisible: e.vendor_visible,
      remainingRiskAcknowledged: e.remaining_risk_acknowledged,
      approvedBy: e.approved_by,
      approvedAt: e.approved_at,
      reopenedAt: e.reopened_at,
      supportingDocumentId: e.supporting_document_id,
    })),
  };
}

async function toCaseViews(
  cases: ComplianceCaseRow[],
  projectNames: Map<string, string>,
): Promise<ComplianceCaseView[]> {
  return Promise.all(
    cases.map(async (c) => {
      const [deficiencies, runs] = await Promise.all([
        listDeficienciesForCase(c.id),
        listEvaluationRunsForCase(c.id),
      ]);
      const exceptions = await Promise.all(
        deficiencies.map((d) => listExceptionsForDeficiency(d.id)),
      );
      return {
        caseId: c.id,
        assignmentId: c.assignment_id,
        vendorId: c.vendor_id,
        projectName: projectNames.get(c.assignment_id) ?? "Unknown project",
        openedAt: c.opened_at,
        updatedAt: c.updated_at,
        uploadRequestId: c.upload_request_id,
        deficiencies: deficiencies.map((d) =>
          toDeficiencyView(d, runs, exceptions[deficiencies.indexOf(d)] ?? []),
        ),
        evaluationRuns: runs.map((r) => ({
          id: r.id,
          packageId: r.package_id,
          evaluatedAt: r.evaluated_at,
        })),
      };
    }),
  );
}

/** assignment_id → project name for the given cases, RLS-scoped. */
async function projectNamesForAssignments(assignmentIds: string[]): Promise<Map<string, string>> {
  if (assignmentIds.length === 0) return new Map();
  const supabase = await getRequestScopedClient();
  const { data, error } = await supabase
    .from("project_vendor_assignments")
    .select("id, project:projects(id, name)")
    .in("id", assignmentIds);
  if (error) throw new Error(error.message);
  const names = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    id: string;
    project: { name: string } | { name: string }[] | null;
  }>) {
    const project = Array.isArray(row.project) ? row.project[0] : row.project;
    names.set(row.id, project?.name ?? "Unknown project");
  }
  return names;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const getVendorCompliance = createServerFn({ method: "GET" })
  .validator(z.object({ vendorId: z.string().uuid() }))
  .handler(async ({ data }): Promise<ComplianceCaseView[]> => {
    const cases = await listCasesForVendor(data.vendorId);
    const names = await projectNamesForAssignments(cases.map((c) => c.assignment_id));
    return toCaseViews(cases, names);
  });

export const getAssignmentCompliance = createServerFn({ method: "GET" })
  .validator(z.object({ assignmentId: z.string().uuid() }))
  .handler(async ({ data }): Promise<ComplianceCaseView[]> => {
    const cases = await listCasesForAssignment(data.assignmentId);
    const names = await projectNamesForAssignments([data.assignmentId]);
    return toCaseViews(cases, names);
  });

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Starts (or, per the RPC's own semantics, restarts) the correction clock on
 * each open deficiency. The actual email to the vendor goes through the
 * suppression-safe sendRequest() path separately - this RPC only sets
 * correction_requested_at/escalation_level. Calling both is the caller's
 * (the composer's) job; see DeficiencySection's send flow.
 */
export const requestCorrection = createServerFn({ method: "POST" })
  .validator(z.object({ deficiencyIds: z.array(z.string().uuid()).min(1) }))
  .handler(async ({ data }): Promise<{ requested: number }> => {
    for (const id of data.deficiencyIds) {
      await requestDeficiencyCorrection(id);
    }
    return { requested: data.deficiencyIds.length };
  });

const approveExceptionSchema = z.object({
  deficiencyId: z.string().uuid(),
  reason: z.string().trim().min(1, "A reason is required.").max(2000),
  effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter an effective date."),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter an expiration date."),
  supportingDocumentId: z.string().uuid().nullish(),
  vendorVisible: z.boolean().default(false),
  remainingRiskAcknowledged: z.boolean(),
});

/**
 * Approves an exception via approve_compliance_exception(). The
 * remaining-risk acknowledgement is enforced here as well as in the UI:
 * the DB column is NOT NULL but would accept false, and an exception filed
 * without the approver explicitly acknowledging the remaining risk would be
 * exactly the shortcut the plan forbids. Role authorization (owner/
 * risk_manager) is the RPC's own check - a role the UI hides the form for
 * still cannot sneak past this function.
 */
export const approveException = createServerFn({ method: "POST" })
  .validator(approveExceptionSchema)
  .handler(async ({ data }): Promise<{ exceptionId: string }> => {
    if (!data.remainingRiskAcknowledged) {
      throw new Error("Confirm the remaining-risk acknowledgement before approving an exception.");
    }
    if (data.expiresOn <= data.effectiveOn) {
      throw new Error("The expiration date must be after the effective date.");
    }
    const input: ComplianceExceptionInput = {
      deficiencyId: data.deficiencyId,
      reason: data.reason,
      effectiveOn: data.effectiveOn,
      expiresOn: data.expiresOn,
      vendorVisible: data.vendorVisible,
      remainingRiskAcknowledged: true,
    };
    if (data.supportingDocumentId) input.supportingDocumentId = data.supportingDocumentId;
    const exceptionId = await approveComplianceException(input);
    return { exceptionId };
  });
