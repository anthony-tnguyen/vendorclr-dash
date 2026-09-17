import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Task 10a - apply_evaluation_result()/approve_compliance_exception()
 * (20260917001200_compliance_cases.sql). See that migration's own docblock
 * for the full shape (immutable compliance_evaluation_runs, live-cache
 * compliance_deficiencies). The single most important property under test
 * here is the waiver-freeze invariant: once a deficiency is waived via an
 * approved exception, apply_evaluation_result() must never touch it again -
 * not to reopen it on a regression, not to resolve it on a clean run.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const RISK_MANAGER = "22222222-2222-2222-2222-222222222222";
const READ_ONLY = "33333333-3333-3333-3333-333333333333";
const OTHER_OWNER = "44444444-4444-4444-4444-444444444444";

let db: PGlite;
let companyId: string;
let otherCompanyId: string;
let projectId: string;
let vendorId: string;
let assignmentId: string;
let uploadRequestId: string;
let packageId: string;

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

async function applyResult(
  userId: string,
  args: {
    companyId: string;
    vendorId: string;
    assignmentId: string;
    uploadRequestId: string;
    packageId: string;
    evaluatedAt?: string;
    requirements?: unknown[];
    findings?: unknown[];
  },
): Promise<string> {
  const rows = await asUser<{ apply_evaluation_result: string }>(
    db,
    userId,
    `select public.apply_evaluation_result($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) as apply_evaluation_result`,
    [
      args.companyId,
      args.vendorId,
      args.assignmentId,
      args.uploadRequestId,
      args.packageId,
      args.evaluatedAt ?? new Date().toISOString(),
      JSON.stringify(args.requirements ?? [requirement()]),
      JSON.stringify(args.findings ?? [finding()]),
    ],
  );
  return rows[0]!.apply_evaluation_result;
}

async function approveException(
  userId: string,
  args: {
    deficiencyId: string;
    reason?: string;
    effectiveOn?: string;
    expiresOn?: string;
    supportingDocumentId?: string | null;
    vendorVisible?: boolean;
    remainingRiskAcknowledged?: boolean;
  },
): Promise<string> {
  const rows = await asUser<{ approve_compliance_exception: string }>(
    db,
    userId,
    `select public.approve_compliance_exception($1, $2, $3, $4, $5, $6, $7) as approve_compliance_exception`,
    [
      args.deficiencyId,
      args.reason ?? "Vendor has an equivalent umbrella policy pending renewal.",
      args.effectiveOn ?? "2026-01-01",
      args.expiresOn ?? "2026-06-01",
      args.supportingDocumentId ?? null,
      args.vendorVisible ?? false,
      args.remainingRiskAcknowledged ?? true,
    ],
  );
  return rows[0]!.approve_compliance_exception;
}

async function getDeficiency(requirementKey: string, caseId: string) {
  const rows = await db.query<{
    id: string;
    status: string;
    last_evaluation_run_id: string;
    first_evaluation_run_id: string;
    resolved_at: string | null;
    resolved_by_evaluation_run_id: string | null;
    waived_via_exception_id: string | null;
  }>(
    `select id, status, last_evaluation_run_id, first_evaluation_run_id, resolved_at,
            resolved_by_evaluation_run_id, waived_via_exception_id
     from public.compliance_deficiencies where case_id = $1 and requirement_key = $2`,
    [caseId, requirementKey],
  );
  return rows.rows[0] ?? null;
}

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@ridgeline.test", companyName: "Ridgeline GC" });
  companyId = await companyIdFor(db, OWNER);

  await db.query(`insert into auth.users (id, email) values ($1, 'rm@ridgeline.test')`, [
    RISK_MANAGER,
  ]);
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'risk_manager')`,
    [companyId, RISK_MANAGER],
  );
  await db.query(`insert into auth.users (id, email) values ($1, 'ro@ridgeline.test')`, [
    READ_ONLY,
  ]);
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only')`,
    [companyId, READ_ONLY],
  );

  await signUp(db, { id: OTHER_OWNER, email: "owner@other.test", companyName: "Other Co" });
  otherCompanyId = await companyIdFor(db, OTHER_OWNER);

  const project = await db.query<{ id: string }>(
    `insert into public.projects (company_id, name) values ($1, 'Compliance Cases Site') returning id`,
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

  const uploadRequest = await db.query<{ id: string }>(
    `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
     values ($1, $2, 'hash-compliance-cases', now() + interval '14 days') returning id`,
    [companyId, vendorId],
  );
  uploadRequestId = uploadRequest.rows[0]!.id;

  const pkg = await db.query<{ id: string }>(
    `insert into public.submission_packages (company_id, vendor_id, upload_request_id)
     values ($1, $2, $3) returning id`,
    [companyId, vendorId, uploadRequestId],
  );
  packageId = pkg.rows[0]!.id;
}, 60_000);

describe("apply_evaluation_result()", () => {
  it("creates a case, an immutable run, and a deficiency only for deficient/unknown findings", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      requirements: [
        requirement({ key: "gl_each_occ" }),
        requirement({ key: "ai_endorsement", kind: "endorsement", amount: null }),
        requirement({ key: "wc_limit" }),
      ],
      findings: [
        finding({ requirementKey: "gl_each_occ", state: "deficient" }),
        finding({ requirementKey: "ai_endorsement", state: "unknown", observed: null }),
        finding({ requirementKey: "wc_limit", state: "verified", observed: { amount: 1000000 } }),
      ],
    });

    const caseRow = await db.query<{ id: string; company_id: string; vendor_id: string }>(
      `select id, company_id, vendor_id from public.compliance_cases where id = $1`,
      [caseId],
    );
    expect(caseRow.rows[0]).toMatchObject({ company_id: companyId, vendor_id: vendorId });

    const runRow = await db.query<{ id: string }>(
      `select id from public.compliance_evaluation_runs where case_id = $1`,
      [caseId],
    );
    expect(runRow.rows).toHaveLength(1);

    const deficiencies = await db.query<{ requirement_key: string; status: string }>(
      `select requirement_key, status from public.compliance_deficiencies where case_id = $1 order by requirement_key`,
      [caseId],
    );
    expect(deficiencies.rows).toEqual([
      { requirement_key: "ai_endorsement", status: "open" },
      { requirement_key: "gl_each_occ", status: "open" },
    ]);
  });

  it("get-or-creates the same case on a resubmission, updating the same deficiency row in place", async () => {
    const uploadRequest = await db.query<{ id: string }>(
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'hash-resubmission', now() + interval '14 days') returning id`,
      [companyId, vendorId],
    );
    const requestId = uploadRequest.rows[0]!.id;
    const pkg1 = await db.query<{ id: string }>(
      `insert into public.submission_packages (company_id, vendor_id, upload_request_id)
       values ($1, $2, $3) returning id`,
      [companyId, vendorId, requestId],
    );

    const caseId1 = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId: requestId,
      packageId: pkg1.rows[0]!.id,
      findings: [finding({ requirementKey: "resub_key", state: "deficient" })],
      requirements: [requirement({ key: "resub_key" })],
    });

    const before = await getDeficiency("resub_key", caseId1);
    expect(before).not.toBeNull();

    // Simulate a resubmission: a second package version against the SAME
    // upload request, still deficient for the same requirement_key.
    await db.query(`update public.submission_packages set status = 'superseded' where id = $1`, [
      pkg1.rows[0]!.id,
    ]);
    const pkg2 = await db.query<{ id: string }>(
      `insert into public.submission_packages (company_id, vendor_id, upload_request_id, version, previous_package_id)
       values ($1, $2, $3, 2, $4) returning id`,
      [companyId, vendorId, requestId, pkg1.rows[0]!.id],
    );

    const caseId2 = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId: requestId,
      packageId: pkg2.rows[0]!.id,
      findings: [
        finding({
          requirementKey: "resub_key",
          state: "deficient",
          observed: { amount: 1500000 },
          explanation: "Still below the required limit.",
        }),
      ],
      requirements: [requirement({ key: "resub_key" })],
    });

    expect(caseId2).toBe(caseId1);

    const rows = await db.query(
      `select id from public.compliance_deficiencies where case_id = $1 and requirement_key = $2`,
      [caseId1, "resub_key"],
    );
    expect(rows.rows).toHaveLength(1);

    const after = await getDeficiency("resub_key", caseId1);
    expect(after!.id).toBe(before!.id);
    expect(after!.last_evaluation_run_id).not.toBe(before!.last_evaluation_run_id);
    expect(after!.status).toBe("open");
  });

  it("resolves a deficiency once its requirement is verified on a later run", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "resolve_key", state: "deficient" })],
      requirements: [requirement({ key: "resolve_key" })],
    });

    const openRow = await getDeficiency("resolve_key", caseId);
    expect(openRow!.status).toBe("open");

    await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [
        finding({
          requirementKey: "resolve_key",
          state: "verified",
          observed: { amount: 3000000 },
        }),
      ],
      requirements: [requirement({ key: "resolve_key" })],
    });

    const resolvedRow = await getDeficiency("resolve_key", caseId);
    expect(resolvedRow!.status).toBe("resolved");
    expect(resolvedRow!.resolved_at).not.toBeNull();
    expect(resolvedRow!.resolved_by_evaluation_run_id).not.toBeNull();
  });

  it("reopens a resolved deficiency that regresses back to deficient on a third run", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "regress_key", state: "deficient" })],
      requirements: [requirement({ key: "regress_key" })],
    });

    await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "regress_key", state: "verified" })],
      requirements: [requirement({ key: "regress_key" })],
    });
    const resolvedRow = await getDeficiency("regress_key", caseId);
    expect(resolvedRow!.status).toBe("resolved");

    await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "regress_key", state: "deficient" })],
      requirements: [requirement({ key: "regress_key" })],
    });

    const reopenedRow = await getDeficiency("regress_key", caseId);
    expect(reopenedRow!.status).toBe("open");
    expect(reopenedRow!.resolved_at).toBeNull();
    expect(reopenedRow!.resolved_by_evaluation_run_id).toBeNull();
    expect(reopenedRow!.id).toBe(resolvedRow!.id);

    const rows = await db.query(
      `select id from public.compliance_deficiencies where case_id = $1 and requirement_key = $2`,
      [caseId, "regress_key"],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("never touches a waived deficiency - not to reopen it, not to resolve it out from under itself", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "waive_key", state: "deficient" })],
      requirements: [requirement({ key: "waive_key" })],
    });

    const openRow = await getDeficiency("waive_key", caseId);
    const exceptionId = await approveException(OWNER, { deficiencyId: openRow!.id });

    const waivedRow = await getDeficiency("waive_key", caseId);
    expect(waivedRow!.status).toBe("waived");
    expect(waivedRow!.waived_via_exception_id).toBe(exceptionId);

    // Still deficient on a fresh run - must stay waived, not reopen.
    await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "waive_key", state: "deficient" })],
      requirements: [requirement({ key: "waive_key" })],
    });
    const stillWaivedAfterDeficient = await getDeficiency("waive_key", caseId);
    expect(stillWaivedAfterDeficient!.status).toBe("waived");
    expect(stillWaivedAfterDeficient!.waived_via_exception_id).toBe(exceptionId);

    // Now verified - must ALSO stay waived, not be silently "resolved out
    // from under" the exception. Only Task 10b's future expiry sweep changes
    // a waived row's status.
    await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "waive_key", state: "verified" })],
      requirements: [requirement({ key: "waive_key" })],
    });
    const stillWaivedAfterVerified = await getDeficiency("waive_key", caseId);
    expect(stillWaivedAfterVerified!.status).toBe("waived");
    expect(stillWaivedAfterVerified!.waived_via_exception_id).toBe(exceptionId);
  });

  it("raises for a cross-tenant assignment/company id combination (IDOR)", async () => {
    await expect(
      applyResult(OTHER_OWNER, {
        companyId,
        vendorId,
        assignmentId,
        uploadRequestId,
        packageId,
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it("raises for a company id the caller does not belong to at all", async () => {
    await expect(
      applyResult(OWNER, {
        companyId: otherCompanyId,
        vendorId,
        assignmentId,
        uploadRequestId,
        packageId,
      }),
    ).rejects.toThrow();
  });
});

describe("approve_compliance_exception()", () => {
  it("rejects a caller who is not owner/risk_manager", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "role_gate_key", state: "deficient" })],
      requirements: [requirement({ key: "role_gate_key" })],
    });
    const row = await getDeficiency("role_gate_key", caseId);

    await expect(approveException(READ_ONLY, { deficiencyId: row!.id })).rejects.toThrow(
      /not authorized/,
    );
  });

  it("allows a risk_manager to approve", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "rm_approve_key", state: "deficient" })],
      requirements: [requirement({ key: "rm_approve_key" })],
    });
    const row = await getDeficiency("rm_approve_key", caseId);

    const exceptionId = await approveException(RISK_MANAGER, { deficiencyId: row!.id });
    expect(exceptionId).toBeTruthy();

    const audit = await db.query<{ action: string; target_type: string; target_id: string }>(
      `select action, target_type, target_id from public.audit_log
       where action = 'compliance_exception_approved' and target_id = $1`,
      [row!.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.target_type).toBe("compliance_deficiency");
  });

  it("rejects a deficiency that is already resolved", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "already_resolved_key", state: "deficient" })],
      requirements: [requirement({ key: "already_resolved_key" })],
    });
    await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "already_resolved_key", state: "verified" })],
      requirements: [requirement({ key: "already_resolved_key" })],
    });
    const row = await getDeficiency("already_resolved_key", caseId);
    expect(row!.status).toBe("resolved");

    await expect(approveException(OWNER, { deficiencyId: row!.id })).rejects.toThrow(/is not open/);
  });

  it("rejects a deficiency that is already waived", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "already_waived_key", state: "deficient" })],
      requirements: [requirement({ key: "already_waived_key" })],
    });
    const row = await getDeficiency("already_waived_key", caseId);
    await approveException(OWNER, { deficiencyId: row!.id });

    await expect(approveException(OWNER, { deficiencyId: row!.id })).rejects.toThrow(/is not open/);
  });

  it("rejects cross-company access to someone else's deficiency with a generic error", async () => {
    const caseId = await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [finding({ requirementKey: "cross_tenant_key", state: "deficient" })],
      requirements: [requirement({ key: "cross_tenant_key" })],
    });
    const row = await getDeficiency("cross_tenant_key", caseId);

    await expect(approveException(OTHER_OWNER, { deficiencyId: row!.id })).rejects.toThrow(
      /not authorized/,
    );
  });

  it("raises for a deficiency id that does not exist at all, same generic error", async () => {
    await expect(
      approveException(OWNER, { deficiencyId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow(/not authorized/);
  });
});
