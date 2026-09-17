import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Task 10b - request_deficiency_correction()/mark_deficiency_escalated()/
 * reopen_expired_compliance_exception() and the two due-for views
 * (20260917001300_compliance_case_escalation.sql). See that migration's own
 * docblock for the full shape.
 *
 * mark_deficiency_escalated()/reopen_expired_compliance_exception() are
 * service-role-only (not SECURITY DEFINER, same as record_document_extraction() -
 * see the migration's own comment) - called directly via db.query (the
 * PGlite superuser connection, same as claim_document_processing_jobs()'s
 * own "eligibility" tests in document-processing-job-claim.test.ts), not via
 * asUser(), since there is no RLS/role boundary for a service-role-only
 * function to exercise through a signed-in session.
 *
 * PGlite is single-connection and cannot prove true concurrency (see
 * document-processing-job-claim.test.ts's own extensive docblock on this) -
 * the idempotency/live-recheck tests below are sequential correctness tests,
 * not concurrency proofs, which is sufficient here: both functions are
 * idempotent/live-rechecking by construction (verified by reading the SQL),
 * not by a misleading Promise.all test.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "44444444-4444-4444-4444-444444444444";

let db: PGlite;
let companyId: string;
let otherCompanyId: string;
let projectId: string;
let vendorId: string;
let assignmentId: string;

let caseSeq = 0;

function finding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    requirementKey: "gl_each_occ",
    state: "deficient",
    expected: { required: true, policyType: "general_liability", amount: 2000000 },
    observed: null,
    evidenceDocumentIds: [],
    explanation: "No general_liability policy line was found in this submission.",
    ...overrides,
  };
}

function requirement(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    key: "gl_each_occ",
    policyType: "general_liability",
    kind: "limit",
    required: true,
    amount: 2000000,
    source: "company_profile",
    configuration: { limitField: "each_occurrence" },
    ...overrides,
  };
}

/** Creates a fresh case + one open deficiency for the given requirement key, via apply_evaluation_result(), and returns the deficiency id. */
async function seedOpenDeficiency(requirementKey: string): Promise<string> {
  caseSeq += 1;
  const uploadRequest = await db.query<{ id: string }>(
    `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '14 days') returning id`,
    [companyId, vendorId, `hash-escalation-${caseSeq}`],
  );
  const requestId = uploadRequest.rows[0]!.id;
  const pkg = await db.query<{ id: string }>(
    `insert into public.submission_packages (company_id, vendor_id, upload_request_id)
     values ($1, $2, $3) returning id`,
    [companyId, vendorId, requestId],
  );

  const rows = await asUser<{ apply_evaluation_result: string }>(
    db,
    OWNER,
    `select public.apply_evaluation_result($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) as apply_evaluation_result`,
    [
      companyId,
      vendorId,
      assignmentId,
      requestId,
      pkg.rows[0]!.id,
      new Date().toISOString(),
      JSON.stringify([requirement({ key: requirementKey })]),
      JSON.stringify([finding({ requirementKey })]),
    ],
  );
  const caseId = rows[0]!.apply_evaluation_result;

  const deficiency = await db.query<{ id: string }>(
    `select id from public.compliance_deficiencies where case_id = $1 and requirement_key = $2`,
    [caseId, requirementKey],
  );
  return deficiency.rows[0]!.id;
}

async function requestCorrection(userId: string, deficiencyId: string): Promise<void> {
  await asUser(db, userId, `select public.request_deficiency_correction($1)`, [deficiencyId]);
}

/** Backdates correction_requested_at (and optionally escalation_level) directly - simulates time having passed, without waiting real days. */
async function backdateCorrectionRequest(
  deficiencyId: string,
  intervalAgo: string,
  escalationLevel = 0,
): Promise<void> {
  await db.query(
    `update public.compliance_deficiencies
     set correction_requested_at = now() - $2::interval, escalation_level = $3
     where id = $1`,
    [deficiencyId, intervalAgo, escalationLevel],
  );
}

async function getDeficiency(deficiencyId: string) {
  const rows = await db.query<{
    id: string;
    status: string;
    correction_requested_at: string | null;
    escalation_level: number;
    last_escalated_at: string | null;
  }>(
    `select id, status, correction_requested_at, escalation_level, last_escalated_at
     from public.compliance_deficiencies where id = $1`,
    [deficiencyId],
  );
  return rows.rows[0] ?? null;
}

async function approveException(deficiencyId: string, expiresOn: string): Promise<string> {
  const rows = await asUser<{ approve_compliance_exception: string }>(
    db,
    OWNER,
    `select public.approve_compliance_exception($1, $2, $3, $4, $5, $6, $7) as approve_compliance_exception`,
    [
      deficiencyId,
      "Vendor has an equivalent umbrella policy pending renewal.",
      "2019-01-01",
      expiresOn,
      null,
      false,
      true,
    ],
  );
  return rows[0]!.approve_compliance_exception;
}

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@escalation.test", companyName: "Escalation GC" });
  companyId = await companyIdFor(db, OWNER);

  await signUp(db, {
    id: OTHER_OWNER,
    email: "owner@escalation-other.test",
    companyName: "Other Co",
  });
  otherCompanyId = await companyIdFor(db, OTHER_OWNER);

  const project = await db.query<{ id: string }>(
    `insert into public.projects (company_id, name) values ($1, 'Escalation Site') returning id`,
    [companyId],
  );
  projectId = project.rows[0]!.id;

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Cascade Steel', 'Structural Steel')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;

  const assignment = await db.query<{ id: string }>(
    `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
     values ($1, $2, $3) returning id`,
    [companyId, projectId, vendorId],
  );
  assignmentId = assignment.rows[0]!.id;
}, 60_000);

describe("request_deficiency_correction()", () => {
  it("sets correction_requested_at and resets escalation_level/last_escalated_at", async () => {
    const deficiencyId = await seedOpenDeficiency("req_correction_key");
    await backdateCorrectionRequest(deficiencyId, "1 day", 2);

    await requestCorrection(OWNER, deficiencyId);

    const after = await getDeficiency(deficiencyId);
    expect(after!.correction_requested_at).not.toBeNull();
    expect(after!.escalation_level).toBe(0);
    expect(after!.last_escalated_at).toBeNull();
  });

  it("rejects a deficiency that is not open", async () => {
    const deficiencyId = await seedOpenDeficiency("req_not_open_key");
    await approveException(deficiencyId, "2026-06-01");

    await expect(requestCorrection(OWNER, deficiencyId)).rejects.toThrow(/is not open/);
  });

  it("rejects cross-tenant access with the generic error", async () => {
    const deficiencyId = await seedOpenDeficiency("req_cross_tenant_key");

    await expect(requestCorrection(OTHER_OWNER, deficiencyId)).rejects.toThrow(/not authorized/);
  });

  it("raises the generic error for a deficiency id that does not exist", async () => {
    await expect(requestCorrection(OWNER, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /not authorized/,
    );
  });
});

describe("compliance_deficiencies_due_for_escalation", () => {
  async function dueRow(deficiencyId: string) {
    const rows = await db.query<{ deficiency_id: string; next_level: number }>(
      `select deficiency_id, next_level from public.compliance_deficiencies_due_for_escalation
       where deficiency_id = $1`,
      [deficiencyId],
    );
    return rows.rows[0] ?? null;
  }

  it("excludes a deficiency just under the 3-day threshold at level 0", async () => {
    const deficiencyId = await seedOpenDeficiency("view_under_3d_key");
    await backdateCorrectionRequest(deficiencyId, "2 days 23 hours", 0);
    expect(await dueRow(deficiencyId)).toBeNull();
  });

  it("includes a deficiency just over the 3-day threshold at level 0, next_level 1", async () => {
    const deficiencyId = await seedOpenDeficiency("view_over_3d_key");
    await backdateCorrectionRequest(deficiencyId, "3 days 1 hour", 0);
    const row = await dueRow(deficiencyId);
    expect(row).not.toBeNull();
    expect(row!.next_level).toBe(1);
  });

  it("excludes a deficiency at level 1 just over 3 days but under 7 days", async () => {
    const deficiencyId = await seedOpenDeficiency("view_level1_under_7d_key");
    await backdateCorrectionRequest(deficiencyId, "4 days", 1);
    expect(await dueRow(deficiencyId)).toBeNull();
  });

  it("includes a deficiency at level 1 just over the 7-day threshold, next_level 2", async () => {
    const deficiencyId = await seedOpenDeficiency("view_over_7d_key");
    await backdateCorrectionRequest(deficiencyId, "7 days 1 hour", 1);
    const row = await dueRow(deficiencyId);
    expect(row).not.toBeNull();
    expect(row!.next_level).toBe(2);
  });

  it("includes a deficiency at level 2 just over the 14-day threshold, next_level 3", async () => {
    const deficiencyId = await seedOpenDeficiency("view_over_14d_key");
    await backdateCorrectionRequest(deficiencyId, "14 days 1 hour", 2);
    const row = await dueRow(deficiencyId);
    expect(row).not.toBeNull();
    expect(row!.next_level).toBe(3);
  });

  it("never includes a deficiency at level 3, regardless of age", async () => {
    const deficiencyId = await seedOpenDeficiency("view_level3_key");
    await backdateCorrectionRequest(deficiencyId, "60 days", 3);
    expect(await dueRow(deficiencyId)).toBeNull();
  });

  it("excludes a deficiency with no correction request at all", async () => {
    const deficiencyId = await seedOpenDeficiency("view_no_request_key");
    expect(await dueRow(deficiencyId)).toBeNull();
  });
});

describe("mark_deficiency_escalated()", () => {
  it("updates escalation_level and last_escalated_at", async () => {
    const deficiencyId = await seedOpenDeficiency("mark_escalate_key");
    await backdateCorrectionRequest(deficiencyId, "4 days", 0);

    await db.query(`select public.mark_deficiency_escalated($1, $2)`, [deficiencyId, 1]);

    const after = await getDeficiency(deficiencyId);
    expect(after!.escalation_level).toBe(1);
    expect(after!.last_escalated_at).not.toBeNull();
  });

  it("is a no-op against a deficiency that has since become resolved", async () => {
    const deficiencyId = await seedOpenDeficiency("mark_resolved_noop_key");
    await backdateCorrectionRequest(deficiencyId, "4 days", 0);

    // Resolve it via a fresh clean evaluation run for the same requirement key.
    const case_ = await db.query<{ case_id: string }>(
      `select case_id from public.compliance_deficiencies where id = $1`,
      [deficiencyId],
    );
    const caseId = case_.rows[0]!.case_id;
    const caseRow = await db.query<{ assignment_id: string; upload_request_id: string }>(
      `select assignment_id, upload_request_id from public.compliance_cases where id = $1`,
      [caseId],
    );
    // A second package version against the SAME upload request - reusing a
    // fresh upload_request_id would open a NEW case (compliance_cases is
    // keyed by (assignment_id, upload_request_id)) rather than updating this
    // deficiency's own case, so this mirrors compliance-cases.test.ts's own
    // "resubmission" pattern: supersede the first package, insert a second
    // version pointing back at it.
    const firstPkg = await db.query<{ id: string }>(
      `select id from public.submission_packages where upload_request_id = $1 order by version asc limit 1`,
      [caseRow.rows[0]!.upload_request_id],
    );
    await db.query(`update public.submission_packages set status = 'superseded' where id = $1`, [
      firstPkg.rows[0]!.id,
    ]);
    const pkg = await db.query<{ id: string }>(
      `insert into public.submission_packages (company_id, vendor_id, upload_request_id, version, previous_package_id)
       values ($1, $2, $3, 2, $4) returning id`,
      [companyId, vendorId, caseRow.rows[0]!.upload_request_id, firstPkg.rows[0]!.id],
    );
    await asUser(
      db,
      OWNER,
      `select public.apply_evaluation_result($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [
        companyId,
        vendorId,
        caseRow.rows[0]!.assignment_id,
        caseRow.rows[0]!.upload_request_id,
        pkg.rows[0]!.id,
        new Date().toISOString(),
        JSON.stringify([requirement({ key: "mark_resolved_noop_key" })]),
        JSON.stringify([
          finding({
            requirementKey: "mark_resolved_noop_key",
            state: "verified",
            observed: { amount: 3000000 },
          }),
        ]),
      ],
    );

    const resolved = await getDeficiency(deficiencyId);
    expect(resolved!.status).toBe("resolved");

    await db.query(`select public.mark_deficiency_escalated($1, $2)`, [deficiencyId, 1]);

    const after = await getDeficiency(deficiencyId);
    expect(after!.status).toBe("resolved");
    // Untouched - still whatever backdateCorrectionRequest set it to (0).
    expect(after!.escalation_level).toBe(0);
    expect(after!.last_escalated_at).toBeNull();
  });

  it("grants: anon/authenticated cannot execute it, service_role can", async () => {
    async function canExecute(role: "anon" | "authenticated" | "service_role"): Promise<boolean> {
      const result = await db.query<{ can_exec: boolean }>(
        `select has_function_privilege($1, 'public.mark_deficiency_escalated(uuid,smallint)'::regprocedure, 'EXECUTE') as can_exec`,
        [role],
      );
      return result.rows[0]?.can_exec ?? false;
    }
    expect(await canExecute("anon")).toBe(false);
    expect(await canExecute("authenticated")).toBe(false);
    expect(await canExecute("service_role")).toBe(true);
  });
});

describe("compliance_exceptions_due_for_reopening", () => {
  async function dueRow(exceptionId: string) {
    const rows = await db.query<{ exception_id: string }>(
      `select exception_id from public.compliance_exceptions_due_for_reopening where exception_id = $1`,
      [exceptionId],
    );
    return rows.rows[0] ?? null;
  }

  it("excludes an exception that has not expired yet", async () => {
    const deficiencyId = await seedOpenDeficiency("reopen_not_expired_key");
    const exceptionId = await approveException(deficiencyId, "2099-01-01");
    expect(await dueRow(exceptionId)).toBeNull();
  });

  it("includes an expired exception whose deficiency is still waived", async () => {
    const deficiencyId = await seedOpenDeficiency("reopen_expired_key");
    const exceptionId = await approveException(deficiencyId, "2020-01-01");
    expect(await dueRow(exceptionId)).not.toBeNull();
  });

  it("excludes an exception already reopened", async () => {
    const deficiencyId = await seedOpenDeficiency("reopen_already_reopened_key");
    const exceptionId = await approveException(deficiencyId, "2020-01-01");
    await db.query(`update public.compliance_exceptions set reopened_at = now() where id = $1`, [
      exceptionId,
    ]);
    expect(await dueRow(exceptionId)).toBeNull();
  });

  it("excludes an exception whose deficiency is no longer waived", async () => {
    const deficiencyId = await seedOpenDeficiency("reopen_not_waived_key");
    const exceptionId = await approveException(deficiencyId, "2020-01-01");
    // Defensive-state simulation: directly flip the deficiency's status,
    // something no real code path does to a waived row today, but the view
    // must still exclude it if it ever happens.
    await db.query(`update public.compliance_deficiencies set status = 'resolved' where id = $1`, [
      deficiencyId,
    ]);
    expect(await dueRow(exceptionId)).toBeNull();
  });
});

describe("reopen_expired_compliance_exception()", () => {
  it("reopens the deficiency, sets reopened_at, and writes the audit_log row", async () => {
    const deficiencyId = await seedOpenDeficiency("reopen_fn_key");
    const exceptionId = await approveException(deficiencyId, "2020-01-01");

    const rows = await db.query<{ reopen_expired_compliance_exception: string }>(
      `select public.reopen_expired_compliance_exception($1) as reopen_expired_compliance_exception`,
      [exceptionId],
    );
    expect(rows.rows[0]!.reopen_expired_compliance_exception).toBe(deficiencyId);

    const deficiency = await getDeficiency(deficiencyId);
    expect(deficiency!.status).toBe("open");

    const exceptionRow = await db.query<{ reopened_at: string | null }>(
      `select reopened_at from public.compliance_exceptions where id = $1`,
      [exceptionId],
    );
    expect(exceptionRow.rows[0]!.reopened_at).not.toBeNull();

    const audit = await db.query<{ action: string; target_type: string; target_id: string }>(
      `select action, target_type, target_id from public.audit_log
       where action = 'compliance_exception_expired' and target_id = $1`,
      [deficiencyId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.target_type).toBe("compliance_deficiency");
  });

  it("is idempotent - a second call does not double-write or error", async () => {
    const deficiencyId = await seedOpenDeficiency("reopen_idempotent_key");
    const exceptionId = await approveException(deficiencyId, "2020-01-01");

    await db.query(`select public.reopen_expired_compliance_exception($1)`, [exceptionId]);
    // Second call - must not throw, must not write a second audit_log row.
    await db.query(`select public.reopen_expired_compliance_exception($1)`, [exceptionId]);

    const audit = await db.query<{ id: string }>(
      `select id from public.audit_log where action = 'compliance_exception_expired' and target_id = $1`,
      [deficiencyId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("grants: anon/authenticated cannot execute it, service_role can", async () => {
    async function canExecute(role: "anon" | "authenticated" | "service_role"): Promise<boolean> {
      const result = await db.query<{ can_exec: boolean }>(
        `select has_function_privilege($1, 'public.reopen_expired_compliance_exception(uuid)'::regprocedure, 'EXECUTE') as can_exec`,
        [role],
      );
      return result.rows[0]?.can_exec ?? false;
    }
    expect(await canExecute("anon")).toBe(false);
    expect(await canExecute("authenticated")).toBe(false);
    expect(await canExecute("service_role")).toBe(true);
  });
});
