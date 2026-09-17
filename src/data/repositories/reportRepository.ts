import type { PolicyType } from "@/data/dbTypeAliases";

/**
 * Task 11b - the assignment-based reports (the reporting half of Task 11;
 * Task 11a already built the bulk CSV import pipeline). Ten independently
 * testable, read-only functions, one per report the plan lists, plus the
 * point-in-time audit snapshot's write path and a customer-filtered
 * audit_log read. Request-scoped client throughout, same convention as
 * requirementRepository.ts/complianceCaseRepository.ts - every report here
 * is something a signed-in company member can already read under RLS for
 * their own company's data; nothing needs the service role.
 *
 * Each report is its own small query (or small pair of queries joined in
 * TypeScript, where no direct FK exists for PostgREST to embed through - see
 * the "PostgREST embed-with-no-FK gotcha" memory: an embedded select needs a
 * DIRECT FK between the two tables, and PGlite tests can never catch a
 * missing one since they bypass PostgREST entirely). Deliberately NOT one
 * mega-query answering all ten - see the plan's own "keep each report as a
 * genuinely separate, independently-testable function" instruction.
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

// ---------------------------------------------------------------------------
// 1. Project/trade report
// ---------------------------------------------------------------------------

export interface ProjectTradeReportRow {
  projectId: string;
  projectName: string;
  tradeCode: string | null;
  assignmentCount: number;
  openDeficiencyCount: number;
}

/** Assignment counts and open-deficiency counts grouped by project + trade_code. */
export async function getProjectTradeReport(companyId: string): Promise<ProjectTradeReportRow[]> {
  const supabase = await getRequestScopedClient();

  const assignmentsResult = (await supabase
    .from("project_vendor_assignments")
    .select("id, trade_code, project:projects(id, name)")
    .eq("company_id", companyId)) as unknown as {
    data: Array<{
      id: string;
      trade_code: string | null;
      project: { id: string; name: string } | null;
    }> | null;
    error: { message: string } | null;
  };
  const assignments = unwrap({
    data: assignmentsResult.data ?? [],
    error: assignmentsResult.error,
  });

  const deficienciesResult = (await supabase
    .from("compliance_deficiencies")
    .select("id, status, case:compliance_cases(assignment_id)")
    .eq("company_id", companyId)
    .eq("status", "open")) as unknown as {
    data: Array<{ id: string; case: { assignment_id: string } | null }> | null;
    error: { message: string } | null;
  };
  const deficiencies = unwrap({
    data: deficienciesResult.data ?? [],
    error: deficienciesResult.error,
  });

  const openCountByAssignment = new Map<string, number>();
  for (const d of deficiencies) {
    const assignmentId = d.case?.assignment_id;
    if (!assignmentId) continue;
    openCountByAssignment.set(assignmentId, (openCountByAssignment.get(assignmentId) ?? 0) + 1);
  }

  const byKey = new Map<string, ProjectTradeReportRow>();
  for (const a of assignments) {
    if (!a.project) continue;
    const key = `${a.project.id}::${a.trade_code ?? ""}`;
    const existing = byKey.get(key);
    const openCount = openCountByAssignment.get(a.id) ?? 0;
    if (existing) {
      existing.assignmentCount += 1;
      existing.openDeficiencyCount += openCount;
    } else {
      byKey.set(key, {
        projectId: a.project.id,
        projectName: a.project.name,
        tradeCode: a.trade_code,
        assignmentCount: 1,
        openDeficiencyCount: openCount,
      });
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      (a.tradeCode ?? "").localeCompare(b.tradeCode ?? ""),
  );
}

// ---------------------------------------------------------------------------
// 2. 30/60/90 expiry report
// ---------------------------------------------------------------------------

export interface ExpiryReportRow {
  policyId: string;
  vendorId: string;
  vendorName: string;
  policyType: PolicyType;
  expirationDate: string;
  projectId: string | null;
  projectName: string | null;
  assignmentId: string | null;
}

/**
 * vendor_policies expiring within `windowDays` (from today, not yet past
 * due - "expiring within N days" is a forward-looking window, distinct from
 * already-expired coverage), joined through to every project/assignment the
 * covered vendor is on. vendor_policies has no FK to
 * project_vendor_assignments, so the join is done in TypeScript (see this
 * file's own docblock on the embed-with-no-FK gotcha) rather than a
 * PostgREST embed.
 */
export async function getExpiryReport(
  companyId: string,
  windowDays: 30 | 60 | 90,
): Promise<ExpiryReportRow[]> {
  const supabase = await getRequestScopedClient();

  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + windowDays);
  const todayStr = today.toISOString().slice(0, 10);
  const horizonStr = horizon.toISOString().slice(0, 10);

  const policiesResult = (await supabase
    .from("vendor_policies")
    .select("id, vendor_id, policy_type, expiration_date, vendor:vendors(name)")
    .eq("company_id", companyId)
    .eq("status", "active")
    .gte("expiration_date", todayStr)
    .lte("expiration_date", horizonStr)) as unknown as {
    data: Array<{
      id: string;
      vendor_id: string;
      policy_type: PolicyType;
      expiration_date: string;
      vendor: { name: string } | null;
    }> | null;
    error: { message: string } | null;
  };
  const policies = unwrap({ data: policiesResult.data ?? [], error: policiesResult.error });
  if (policies.length === 0) return [];

  const vendorIds = [...new Set(policies.map((p) => p.vendor_id))];
  const assignmentsResult = (await supabase
    .from("project_vendor_assignments")
    .select("id, vendor_id, project:projects(id, name)")
    .in("vendor_id", vendorIds)) as unknown as {
    data: Array<{
      id: string;
      vendor_id: string;
      project: { id: string; name: string } | null;
    }> | null;
    error: { message: string } | null;
  };
  const assignments = unwrap({
    data: assignmentsResult.data ?? [],
    error: assignmentsResult.error,
  });

  const assignmentsByVendor = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = assignmentsByVendor.get(a.vendor_id) ?? [];
    list.push(a);
    assignmentsByVendor.set(a.vendor_id, list);
  }

  const rows: ExpiryReportRow[] = [];
  for (const p of policies) {
    const vendorAssignments = assignmentsByVendor.get(p.vendor_id) ?? [];
    if (vendorAssignments.length === 0) {
      rows.push({
        policyId: p.id,
        vendorId: p.vendor_id,
        vendorName: p.vendor?.name ?? "Unknown vendor",
        policyType: p.policy_type,
        expirationDate: p.expiration_date,
        projectId: null,
        projectName: null,
        assignmentId: null,
      });
      continue;
    }
    for (const a of vendorAssignments) {
      rows.push({
        policyId: p.id,
        vendorId: p.vendor_id,
        vendorName: p.vendor?.name ?? "Unknown vendor",
        policyType: p.policy_type,
        expirationDate: p.expiration_date,
        projectId: a.project?.id ?? null,
        projectName: a.project?.name ?? null,
        assignmentId: a.id,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shared deficiency-with-context read - underlies both the "missing" and
// "open deficiencies" reports, which share the same join shape and differ
// only in their WHERE filter.
// ---------------------------------------------------------------------------

interface DeficiencyWithContext {
  id: string;
  requirement_key: string;
  kind: string | null;
  policy_type: string | null;
  observed: unknown;
  explanation: string;
  status: string;
  case: {
    vendor: { id: string; name: string } | null;
    assignment: { id: string; project: { id: string; name: string } | null } | null;
  } | null;
}

const DEFICIENCY_WITH_CONTEXT_SELECT =
  "id, requirement_key, kind, policy_type, observed, explanation, status, " +
  "case:compliance_cases(vendor:vendors(id, name), assignment:project_vendor_assignments(id, project:projects(id, name)))";

/**
 * Every open deficiency for a company, in document/limit/endorsement kinds,
 * with no evidence recorded at all. Underlies getMissingDocumentationReport().
 *
 * Filters `observed === null` in TypeScript rather than a `.is("observed",
 * null)` PostgREST/SQL filter: apply_evaluation_result()
 * (20260917001200_compliance_cases.sql) writes `observed` from
 * `v_finding -> 'observed'`, and when a finding's JS `observed` value is
 * `null`, the `->` jsonb extraction operator stores a JSONB **json-null
 * literal** in that column, NOT SQL NULL - `observed IS NULL` in SQL is
 * FALSE for such a row (a jsonb column holding json null is a real, non-NULL
 * value). Over the wire, though, both a SQL-NULL column and a JSONB
 * json-null column serialize identically as `"observed": null` in
 * PostgREST's JSON response - so filtering `=== null` after the fetch,
 * rather than trying to express this distinction as a PostgREST filter,
 * correctly treats both cases as "no evidence at all". Found by this
 * report's own PGlite test (supabase/tests/reports.test.ts) coming back
 * empty against seeded data that should have matched.
 */
async function fetchMissingDeficiencies(companyId: string): Promise<DeficiencyWithContext[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_deficiencies")
    .select(DEFICIENCY_WITH_CONTEXT_SELECT)
    .eq("company_id", companyId)
    .eq("status", "open")
    .in("kind", ["document", "limit", "endorsement"])) as unknown as {
    data: DeficiencyWithContext[] | null;
    error: { message: string } | null;
  };
  const rows = unwrap({ data: result.data ?? [], error: result.error });
  return rows.filter((d) => d.observed === null);
}

/** Every open deficiency for a company, any kind, evidence present or not. Underlies getOpenDeficienciesReport(). */
async function fetchOpenDeficiencies(companyId: string): Promise<DeficiencyWithContext[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_deficiencies")
    .select(DEFICIENCY_WITH_CONTEXT_SELECT)
    .eq("company_id", companyId)
    .eq("status", "open")) as unknown as {
    data: DeficiencyWithContext[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

export interface DeficiencyReportRow {
  deficiencyId: string;
  requirementKey: string;
  kind: string | null;
  policyType: string | null;
  explanation: string;
  vendorId: string | null;
  vendorName: string | null;
  projectId: string | null;
  projectName: string | null;
  assignmentId: string | null;
}

function toDeficiencyReportRow(d: DeficiencyWithContext): DeficiencyReportRow {
  return {
    deficiencyId: d.id,
    requirementKey: d.requirement_key,
    kind: d.kind,
    policyType: d.policy_type,
    explanation: d.explanation,
    vendorId: d.case?.vendor?.id ?? null,
    vendorName: d.case?.vendor?.name ?? null,
    projectId: d.case?.assignment?.project?.id ?? null,
    projectName: d.case?.assignment?.project?.name ?? null,
    assignmentId: d.case?.assignment?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// 3. Missing documentation report
// ---------------------------------------------------------------------------

/**
 * Open deficiencies with NO evidence at all (observed is null) for a
 * document/limit/endorsement requirement - genuinely absent, not merely
 * insufficient. Distinct from getOpenDeficienciesReport() below, which is
 * broader and also includes a present-but-insufficient value (observed IS
 * NOT null but still fails the requirement) - the plan's own bullet draws
 * this exact line ("missing" vs. the broader "open deficiencies").
 */
export async function getMissingDocumentationReport(
  companyId: string,
): Promise<DeficiencyReportRow[]> {
  const rows = await fetchMissingDeficiencies(companyId);
  return rows.map(toDeficiencyReportRow);
}

// ---------------------------------------------------------------------------
// 4. Open deficiencies report
// ---------------------------------------------------------------------------

/** Every open deficiency, any kind, present-but-insufficient evidence included - broader than getMissingDocumentationReport() above. */
export async function getOpenDeficienciesReport(companyId: string): Promise<DeficiencyReportRow[]> {
  const rows = await fetchOpenDeficiencies(companyId);
  return rows.map(toDeficiencyReportRow);
}

// ---------------------------------------------------------------------------
// 5. Exceptions report
// ---------------------------------------------------------------------------

export interface ExceptionReportRow {
  exceptionId: string;
  deficiencyId: string;
  requirementKey: string | null;
  reason: string;
  effectiveOn: string;
  expiresOn: string;
  vendorId: string | null;
  vendorName: string | null;
  projectId: string | null;
  projectName: string | null;
  /** expires_on is still in the future and it has not been reopened. */
  isActive: boolean;
  /** Reopened after its expires_on passed - reopen_expired_compliance_exception() already ran for it. */
  isExpiredReopened: boolean;
}

export async function getExceptionsReport(companyId: string): Promise<ExceptionReportRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_exceptions")
    .select(
      "id, deficiency_id, reason, effective_on, expires_on, reopened_at, " +
        "deficiency:compliance_deficiencies(requirement_key, case:compliance_cases(vendor:vendors(id, name), assignment:project_vendor_assignments(project:projects(id, name))))",
    )
    .eq("company_id", companyId)
    .order("approved_at", { ascending: false })) as unknown as {
    data: Array<{
      id: string;
      deficiency_id: string;
      reason: string;
      effective_on: string;
      expires_on: string;
      reopened_at: string | null;
      deficiency: {
        requirement_key: string;
        case: {
          vendor: { id: string; name: string } | null;
          assignment: { project: { id: string; name: string } | null } | null;
        } | null;
      } | null;
    }> | null;
    error: { message: string } | null;
  };
  const rows = unwrap({ data: result.data ?? [], error: result.error });
  const today = new Date().toISOString().slice(0, 10);

  return rows.map((e) => ({
    exceptionId: e.id,
    deficiencyId: e.deficiency_id,
    requirementKey: e.deficiency?.requirement_key ?? null,
    reason: e.reason,
    effectiveOn: e.effective_on,
    expiresOn: e.expires_on,
    vendorId: e.deficiency?.case?.vendor?.id ?? null,
    vendorName: e.deficiency?.case?.vendor?.name ?? null,
    projectId: e.deficiency?.case?.assignment?.project?.id ?? null,
    projectName: e.deficiency?.case?.assignment?.project?.name ?? null,
    isActive: e.reopened_at === null && e.expires_on > today,
    isExpiredReopened: e.reopened_at !== null,
  }));
}

// ---------------------------------------------------------------------------
// 6. Unresponsive report
// ---------------------------------------------------------------------------

export interface UnresponsiveReportRow {
  signal: "upload_request_expired" | "deficiency_correction_overdue";
  vendorId: string;
  vendorName: string;
  /** ISO timestamp of the triggering event - expires_at for the upload-request signal, correction_requested_at for the deficiency signal. */
  since: string;
}

/**
 * Two independent signals for "this vendor needs a nudge", both already
 * established elsewhere in this schema rather than invented fresh here:
 *
 *   1. vendor_upload_requests past expires_at with a status that is not
 *      completed/cancelled/already-expired - mirrors
 *      vendor_upload_requests_open_idx's own comment ("which requests still
 *      need a nudge"), just applied to requests that have now actually
 *      crossed their deadline rather than requests still open before it.
 *   2. compliance_deficiencies at escalation_level = 3 (the 14-day
 *      threshold, compliance-housekeeping's own top tier - see
 *      20260917001300_compliance_case_escalation.sql) with correction still
 *      requested and the deficiency still open - reusing the SAME 14-day
 *      threshold this schema already treats as "the most overdue a
 *      correction request gets" rather than picking a new arbitrary
 *      duration for this report.
 *
 * Both signals are included (not just one) because they cover different
 * failure modes: a vendor who never engaged with an upload request at all
 * vs. a vendor who submitted something but never fixed a flagged deficiency.
 */
export async function getUnresponsiveReport(companyId: string): Promise<UnresponsiveReportRow[]> {
  const supabase = await getRequestScopedClient();
  const nowIso = new Date().toISOString();

  const uploadRequestsResult = (await supabase
    .from("vendor_upload_requests")
    .select("expires_at, vendor:vendors(id, name)")
    .eq("company_id", companyId)
    .lt("expires_at", nowIso)
    .not("status", "in", "(completed,expired,cancelled)")) as unknown as {
    data: Array<{ expires_at: string; vendor: { id: string; name: string } | null }> | null;
    error: { message: string } | null;
  };
  const uploadRequests = unwrap({
    data: uploadRequestsResult.data ?? [],
    error: uploadRequestsResult.error,
  });

  const deficienciesResult = (await supabase
    .from("compliance_deficiencies")
    .select("correction_requested_at, case:compliance_cases(vendor:vendors(id, name))")
    .eq("company_id", companyId)
    .eq("status", "open")
    .eq("escalation_level", 3)
    .not("correction_requested_at", "is", null)) as unknown as {
    data: Array<{
      correction_requested_at: string | null;
      case: { vendor: { id: string; name: string } | null } | null;
    }> | null;
    error: { message: string } | null;
  };
  const deficiencies = unwrap({
    data: deficienciesResult.data ?? [],
    error: deficienciesResult.error,
  });

  const rows: UnresponsiveReportRow[] = [];
  for (const r of uploadRequests) {
    if (!r.vendor) continue;
    rows.push({
      signal: "upload_request_expired",
      vendorId: r.vendor.id,
      vendorName: r.vendor.name,
      since: r.expires_at,
    });
  }
  for (const d of deficiencies) {
    if (!d.case?.vendor || !d.correction_requested_at) continue;
    rows.push({
      signal: "deficiency_correction_overdue",
      vendorId: d.case.vendor.id,
      vendorName: d.case.vendor.name,
      since: d.correction_requested_at,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 7. Bounced report
// ---------------------------------------------------------------------------

export interface BouncedReportRow {
  eventId: string;
  eventType: "bounced" | "complained";
  occurredAt: string;
  toEmail: string;
  vendorId: string | null;
  vendorName: string | null;
}

export async function getBouncedReport(companyId: string): Promise<BouncedReportRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("email_delivery_events")
    .select(
      "id, event_type, occurred_at, email_outbox:email_outbox(to_email, vendor:vendors(id, name))",
    )
    .eq("company_id", companyId)
    .in("event_type", ["bounced", "complained"])
    .order("occurred_at", { ascending: false })) as unknown as {
    data: Array<{
      id: string;
      event_type: "bounced" | "complained";
      occurred_at: string;
      email_outbox: { to_email: string; vendor: { id: string; name: string } | null } | null;
    }> | null;
    error: { message: string } | null;
  };
  const rows = unwrap({ data: result.data ?? [], error: result.error });

  return rows.map((r) => ({
    eventId: r.id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    toEmail: r.email_outbox?.to_email ?? "",
    vendorId: r.email_outbox?.vendor?.id ?? null,
    vendorName: r.email_outbox?.vendor?.name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 8. Time-to-compliance report
// ---------------------------------------------------------------------------

export interface TimeToComplianceReportRow {
  deficiencyId: string;
  requirementKey: string;
  vendorId: string | null;
  vendorName: string | null;
  firstEvaluatedAt: string;
  resolvedAt: string;
  durationHours: number;
}

/**
 * For every RESOLVED deficiency, the duration from its first evaluation run
 * (first_evaluation_run_id.evaluated_at) to when it was resolved
 * (resolved_at). Deliberately two separate queries joined in TypeScript
 * rather than a PostgREST embed: compliance_deficiencies has THREE distinct
 * FK columns into compliance_evaluation_runs (first_evaluation_run_id/
 * last_evaluation_run_id/resolved_by_evaluation_run_id), and disambiguating
 * which one an embed hint resolves to is exactly the kind of PostgREST
 * fragility this project's "embed needs a direct FK" gotcha warns about -
 * a plain second SELECT keyed by id is unambiguous and just as cheap.
 */
export async function getTimeToComplianceReport(
  companyId: string,
): Promise<TimeToComplianceReportRow[]> {
  const supabase = await getRequestScopedClient();

  const deficienciesResult = (await supabase
    .from("compliance_deficiencies")
    .select(
      "id, requirement_key, first_evaluation_run_id, resolved_at, case:compliance_cases(vendor:vendors(id, name))",
    )
    .eq("company_id", companyId)
    .eq("status", "resolved")
    .not("resolved_at", "is", null)) as unknown as {
    data: Array<{
      id: string;
      requirement_key: string;
      first_evaluation_run_id: string;
      resolved_at: string;
      case: { vendor: { id: string; name: string } | null } | null;
    }> | null;
    error: { message: string } | null;
  };
  const deficiencies = unwrap({
    data: deficienciesResult.data ?? [],
    error: deficienciesResult.error,
  });
  if (deficiencies.length === 0) return [];

  const runIds = [...new Set(deficiencies.map((d) => d.first_evaluation_run_id))];
  const runsResult = (await supabase
    .from("compliance_evaluation_runs")
    .select("id, evaluated_at")
    .in("id", runIds)) as unknown as {
    data: Array<{ id: string; evaluated_at: string }> | null;
    error: { message: string } | null;
  };
  const runs = unwrap({ data: runsResult.data ?? [], error: runsResult.error });
  const evaluatedAtByRunId = new Map(runs.map((r) => [r.id, r.evaluated_at]));

  const rows: TimeToComplianceReportRow[] = [];
  for (const d of deficiencies) {
    const firstEvaluatedAt = evaluatedAtByRunId.get(d.first_evaluation_run_id);
    if (!firstEvaluatedAt) continue;
    const durationMs = new Date(d.resolved_at).getTime() - new Date(firstEvaluatedAt).getTime();
    rows.push({
      deficiencyId: d.id,
      requirementKey: d.requirement_key,
      vendorId: d.case?.vendor?.id ?? null,
      vendorName: d.case?.vendor?.name ?? null,
      firstEvaluatedAt,
      resolvedAt: d.resolved_at,
      durationHours: Math.round((durationMs / (1000 * 60 * 60)) * 100) / 100,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 9. Resubmissions report
// ---------------------------------------------------------------------------

export interface ResubmissionsReportRow {
  caseId: string;
  vendorId: string | null;
  vendorName: string | null;
  projectId: string | null;
  projectName: string | null;
  evaluationRunCount: number;
  /** true when more than one run has ever been applied to this case - at least one resubmission occurred. */
  hasResubmission: boolean;
}

export async function getResubmissionsReport(companyId: string): Promise<ResubmissionsReportRow[]> {
  const supabase = await getRequestScopedClient();

  const casesResult = (await supabase
    .from("compliance_cases")
    .select(
      "id, vendor:vendors(id, name), assignment:project_vendor_assignments(project:projects(id, name))",
    )
    .eq("company_id", companyId)) as unknown as {
    data: Array<{
      id: string;
      vendor: { id: string; name: string } | null;
      assignment: { project: { id: string; name: string } | null } | null;
    }> | null;
    error: { message: string } | null;
  };
  const cases = unwrap({ data: casesResult.data ?? [], error: casesResult.error });
  if (cases.length === 0) return [];

  const runsResult = (await supabase
    .from("compliance_evaluation_runs")
    .select("case_id")
    .eq("company_id", companyId)) as unknown as {
    data: Array<{ case_id: string }> | null;
    error: { message: string } | null;
  };
  const runs = unwrap({ data: runsResult.data ?? [], error: runsResult.error });

  const countByCase = new Map<string, number>();
  for (const r of runs) {
    countByCase.set(r.case_id, (countByCase.get(r.case_id) ?? 0) + 1);
  }

  return cases.map((c) => {
    const count = countByCase.get(c.id) ?? 0;
    return {
      caseId: c.id,
      vendorId: c.vendor?.id ?? null,
      vendorName: c.vendor?.name ?? null,
      projectId: c.assignment?.project?.id ?? null,
      projectName: c.assignment?.project?.name ?? null,
      evaluationRunCount: count,
      hasResubmission: count > 1,
    };
  });
}

// ---------------------------------------------------------------------------
// 10. Reviewer turnaround report
// ---------------------------------------------------------------------------

export interface ReviewerTurnaroundReportRow {
  queueItemId: string;
  vendorId: string;
  vendorName: string;
  createdAt: string;
  resolvedAt: string;
  durationHours: number;
}

/**
 * created_at (timestamptz, set at the exact moment a queue item is inserted
 * in the same request as its document - documentReview.ts) rather than
 * submitted_on (a bare `date` defaulting to current_date, at most
 * day-precision and never more informative than created_at) is the
 * meaningful "start" instant for a real duration computation.
 */
export async function getReviewerTurnaroundReport(
  companyId: string,
): Promise<ReviewerTurnaroundReportRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("compliance_queue_items")
    .select("id, created_at, resolved_at, vendor:vendors(id, name)")
    .eq("company_id", companyId)
    .eq("state", "resolved")
    .not("resolved_at", "is", null)) as unknown as {
    data: Array<{
      id: string;
      created_at: string;
      resolved_at: string;
      vendor: { id: string; name: string } | null;
    }> | null;
    error: { message: string } | null;
  };
  const rows = unwrap({ data: result.data ?? [], error: result.error });

  return rows
    .filter((r) => r.vendor !== null)
    .map((r) => {
      const durationMs = new Date(r.resolved_at).getTime() - new Date(r.created_at).getTime();
      return {
        queueItemId: r.id,
        vendorId: r.vendor!.id,
        vendorName: r.vendor!.name,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        durationHours: Math.round((durationMs / (1000 * 60 * 60)) * 100) / 100,
      };
    });
}

// ---------------------------------------------------------------------------
// Point-in-time audit snapshot - write path
// ---------------------------------------------------------------------------

/**
 * Calls create_audit_snapshot() (20260917001600_reporting_audit_snapshots.sql)
 * - the ONLY write path for audit_snapshots. Logs a pilot metric (companyId +
 * event name only, no document/policy/PII content - see this project's Task
 * 11b interpretation of "pilot metrics" in supabase/README.md).
 */
export async function createAuditSnapshot(
  assignmentId: string,
  companyId: string,
): Promise<string> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase.rpc("create_audit_snapshot", {
    assignment_id: assignmentId,
  })) as unknown as { data: string | null; error: { message: string } | null };
  const snapshotId = unwrap(result);

  const { logOperational, newRequestId } = await import("@/lib/observability/logger.server");
  logOperational({
    level: "info",
    event: "pilot_metric.audit_snapshot_created",
    requestId: newRequestId(),
    companyId,
    outcome: "success",
  });

  return snapshotId;
}

export interface AuditSnapshotRow {
  id: string;
  company_id: string;
  assignment_id: string;
  snapshot_taken_at: string;
  requested_by: string;
  requirements_snapshot: unknown;
  evidence_snapshot: unknown;
  created_at: string;
}

/** Reads one existing snapshot row by id - the only way src/workflows/auditSnapshots.ts's render function ever sees snapshot data (never a live re-query). */
export async function getAuditSnapshot(snapshotId: string): Promise<AuditSnapshotRow | null> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("audit_snapshots")
    .select("*")
    .eq("id", snapshotId)
    .maybeSingle()) as unknown as {
    data: AuditSnapshotRow | null;
    error: { message: string } | null;
  };
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

// ---------------------------------------------------------------------------
// Customer-filtered audit history
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: string;
  company_id: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  detail: unknown;
  created_at: string;
}

/**
 * Every audit_log row for a company, newest first. RLS's
 * `company_id in current_company_ids() or is_platform_admin()` already
 * scopes an ordinary read correctly (no other tenant's rows are ever
 * visible), but the plan asks a stronger question: does ANY audit_log row
 * ever get written that represents a platform-admin-only INTERNAL action a
 * customer should not see, merely tagged with THEIR company_id?
 *
 * Answer, verified by reading every current `insert into audit_log` /
 * `.from("audit_log").insert(...)` call site in this codebase (19 total, 9 in
 * SQL migrations, 10 in src/workflows/*.ts as of Task 11b, independently
 * re-counted by a code-review pass after this comment's original count
 * undercounted them): every single one
 * records a real business event about the company's OWN data - an upload
 * request, a document review outcome, a reviewer's extraction correction, a
 * submission package, a compliance exception, a CSV import. Three of these
 * (review_resolved, extraction_reviewer_edit, document_reprocessed) are
 * performed by VendorClr STAFF (assertPlatformAdmin()-gated, service-role
 * writes) rather than by the company's own members, but they are staff
 * acting ON the company's own vendor documents as part of the company's own
 * compliance workflow, not an admin's private investigative action - a
 * customer seeing "a reviewer approved this document on our behalf" is
 * exactly the transparency an audit history is for, not a leak. No call site
 * writes an admin-only event (e.g. an impersonation/login/internal-tooling
 * action) tagged with a customer's company_id. Nothing needs to be excluded
 * today; if a future action type IS ever added that should NOT be
 * customer-visible, add its action string to EXCLUDED_FROM_CUSTOMER_HISTORY
 * below rather than assuming this property still holds silently.
 */
const EXCLUDED_FROM_CUSTOMER_HISTORY: readonly string[] = [];

export async function listCustomerAuditHistory(companyId: string): Promise<AuditLogRow[]> {
  const supabase = await getRequestScopedClient();
  let query = supabase
    .from("audit_log")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (EXCLUDED_FROM_CUSTOMER_HISTORY.length > 0) {
    query = query.not("action", "in", `(${EXCLUDED_FROM_CUSTOMER_HISTORY.join(",")})`);
  }

  const result = (await query) as unknown as {
    data: AuditLogRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}
