import type {
  ComplianceCaseRow,
  ComplianceDeficiencyRow,
  ComplianceEvaluationRunRow,
  ComplianceExceptionRow,
} from "@/data/dbTypeAliases";
import type { ComplianceExceptionInput } from "@/domain/compliance/cases";
import type { EvaluationResult } from "@/domain/compliance/evaluatePackage";

/**
 * Task 10a - thin repository wrapping apply_evaluation_result()/
 * approve_compliance_exception() (supabase/migrations/20260917001200_compliance_cases.sql),
 * plus the read queries needed to make those two write paths testable/usable
 * (list deficiencies for a case, list cases for an assignment). Same request-
 * scoped-client convention as projectRepository.ts/requirementRepository.ts -
 * both RPCs are SECURITY DEFINER with their own explicit authorization check,
 * so calling them through the signed-in caller's own session is correct and
 * sufficient (see each function's own docblock in the migration).
 *
 * No function here (or anywhere else in this file) can set a deficiency to
 * 'resolved' or 'waived' directly - the plan's "never add a generic 'mark
 * compliant' action" holds at this layer too. The only two writes exposed
 * are applyEvaluationResult() (real re-evaluation evidence) and
 * approveComplianceException() (a real approved exception).
 */
async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data and no error");
  return result.data;
}

export interface ApplyEvaluationResultInput {
  companyId: string;
  vendorId: string;
  assignmentId: string;
  uploadRequestId: string;
  result: EvaluationResult;
}

/**
 * Calls apply_evaluation_result(), serializing EvaluationResult's own
 * requirements/findings arrays to jsonb - a near 1:1 mapping of
 * EvaluationResult's fields onto the RPC's parameters (see that function's
 * own docblock). Returns the compliance_cases.id the run was applied
 * against (get-or-created if this is the first evaluation for this
 * assignment/upload-request pair).
 */
export async function applyEvaluationResult(input: ApplyEvaluationResultInput): Promise<string> {
  const supabase = await getRequestScopedClient();

  // Task 11b pilot metric: a fresh evaluation run is about to become the
  // FIRST case ever opened for this (assignment, upload_request) pair only
  // if no compliance_cases row exists for it yet - checked BEFORE the RPC
  // call below, since apply_evaluation_result() itself is get-or-create and
  // gives no signal back about which branch it took. Read-only, RLS-
  // protected (the same company scoping every other read in this file
  // relies on) - never assumed to gate the write itself, just observed
  // ahead of it.
  const existingCaseResult = (await supabase
    .from("compliance_cases")
    .select("id")
    .eq("assignment_id", input.assignmentId)
    .eq("upload_request_id", input.uploadRequestId)
    .maybeSingle()) as unknown as {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  const isNewCase = existingCaseResult.data === null;

  const result = (await supabase.rpc("apply_evaluation_result", {
    p_company_id: input.companyId,
    p_vendor_id: input.vendorId,
    p_assignment_id: input.assignmentId,
    p_upload_request_id: input.uploadRequestId,
    p_package_id: input.result.documentPackageId,
    p_evaluated_at: input.result.evaluatedAt,
    p_requirements_snapshot: input.result.requirements,
    p_findings_snapshot: input.result.findings,
  })) as unknown as {
    data: string | null;
    error: { message: string } | null;
  };
  const caseId = unwrap(result);

  // Pilot metrics (Task 11b) - companyId + event name only, via the
  // existing logOperational() infrastructure (src/lib/observability/
  // logger.server.ts). No document text, policy numbers or contact PII in
  // either payload - see supabase/README.md's Known compromises for the
  // full "pilot metrics" interpretation.
  const { logOperational, newRequestId } = await import("@/lib/observability/logger.server");
  if (isNewCase) {
    logOperational({
      level: "info",
      event: "pilot_metric.compliance_case_opened",
      requestId: newRequestId(),
      companyId: input.companyId,
      outcome: "success",
    });
  }

  return caseId;
}

/**
 * Calls approve_compliance_exception() - the ONLY path that can move a
 * deficiency to 'waived'. See ComplianceExceptionInput's own docblock for
 * why remainingRiskAcknowledged is required even though the plan's earlier
 * TS sketch omitted it. Returns the new compliance_exceptions.id.
 */
export async function approveComplianceException(
  input: ComplianceExceptionInput,
  companyId?: string,
): Promise<string> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase.rpc("approve_compliance_exception", {
    p_deficiency_id: input.deficiencyId,
    p_reason: input.reason,
    p_effective_on: input.effectiveOn,
    p_expires_on: input.expiresOn,
    p_supporting_document_id: input.supportingDocumentId ?? null,
    p_vendor_visible: input.vendorVisible,
    p_remaining_risk_acknowledged: input.remainingRiskAcknowledged,
  })) as unknown as {
    data: string | null;
    error: { message: string } | null;
  };
  const exceptionId = unwrap(result);

  // Pilot metric (Task 11b) - companyId is an optional param (approve_
  // compliance_exception()'s own authorization resolves it server-side from
  // the deficiency's owning case, which this thin wrapper does not
  // otherwise read back out) so existing callers keep working unchanged;
  // when a caller has it on hand, log it - companyId + event name only.
  if (companyId) {
    const { logOperational, newRequestId } = await import("@/lib/observability/logger.server");
    logOperational({
      level: "info",
      event: "pilot_metric.compliance_exception_approved",
      requestId: newRequestId(),
      companyId,
      outcome: "success",
    });
  }

  return exceptionId;
}

/**
 * Calls request_deficiency_correction() (Task 10b,
 * 20260917001300_compliance_case_escalation.sql) - starts the 3/7/14-day
 * escalation clock on an open deficiency by setting correction_requested_at.
 * Same error-handling shape as applyEvaluationResult()/
 * approveComplianceException() above: throws on either an RPC error or a
 * void/undefined result signaling something unexpected, never swallows a
 * failure silently.
 */
export async function requestDeficiencyCorrection(deficiencyId: string): Promise<void> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase.rpc("request_deficiency_correction", {
    p_deficiency_id: deficiencyId,
  })) as unknown as {
    data: null;
    error: { message: string } | null;
  };
  if (result.error) throw new Error(result.error.message);
}

/** Every case opened for one assignment, most recently opened first. */
export async function listCasesForAssignment(assignmentId: string): Promise<ComplianceCaseRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_cases")
    .select("*")
    .eq("assignment_id", assignmentId)
    .order("opened_at", { ascending: false })) as unknown as {
    data: ComplianceCaseRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** One case by id, or null if it does not exist / is not visible to the caller. */
export async function getComplianceCase(caseId: string): Promise<ComplianceCaseRow | null> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle()) as unknown as {
    data: ComplianceCaseRow | null;
    error: { message: string } | null;
  };
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/** Every deficiency ever recorded on a case (any status), most recently created first. */
export async function listDeficienciesForCase(caseId: string): Promise<ComplianceDeficiencyRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_deficiencies")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })) as unknown as {
    data: ComplianceDeficiencyRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/**
 * Only the currently-open deficiencies on a case - what a correction-loop UI
 * actually needs to show a vendor/reviewer "what still needs fixing".
 */
export async function listOpenDeficienciesForCase(
  caseId: string,
): Promise<ComplianceDeficiencyRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_deficiencies")
    .select("*")
    .eq("case_id", caseId)
    .eq("status", "open")
    .order("created_at", { ascending: false })) as unknown as {
    data: ComplianceDeficiencyRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** Every immutable evaluation run applied to a case, most recent first - the full model-vs-evidence history. */
export async function listEvaluationRunsForCase(
  caseId: string,
): Promise<ComplianceEvaluationRunRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_evaluation_runs")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })) as unknown as {
    data: ComplianceEvaluationRunRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** Every approved exception ever recorded against a deficiency (a deficiency can only have one active waiver, but history is kept). */
export async function listExceptionsForDeficiency(
  deficiencyId: string,
): Promise<ComplianceExceptionRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_exceptions")
    .select("*")
    .eq("deficiency_id", deficiencyId)
    .order("approved_at", { ascending: false })) as unknown as {
    data: ComplianceExceptionRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}
