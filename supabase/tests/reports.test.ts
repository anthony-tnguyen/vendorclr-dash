import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Task 11b - create_audit_snapshot() (20260917001600_reporting_audit_snapshots.sql)
 * plus direct-SQL correctness checks for two of reportRepository.ts's report
 * queries (time-to-compliance, resubmissions - "good candidates ... real
 * date-math/counting", per the plan's own guidance) and a third
 * (missing-vs-open-deficiencies) exercising the narrower/broader distinction
 * those two reports draw.
 *
 * reportRepository.ts's functions themselves run through PostgREST
 * (`.from().select()`), which PGlite does not provide - same reason every
 * other request-scoped-client repository in this project (requirementRepository.ts,
 * projectRepository.ts, complianceCaseRepository.ts) has no PGlite test of
 * its own TS layer either; PGlite tests exercise the SQL/RPC/RLS layer
 * beneath a repository, not PostgREST's own query translation. The tests
 * below run the IDENTICAL join/filter shape each report performs directly in
 * SQL against seeded data, proving the underlying data model supports the
 * correct answer - the same thing reportRepository.ts's TypeScript layer
 * would return once PostgREST translates an equivalent `.select()` call.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "44444444-4444-4444-4444-444444444444";

let db: PGlite;
let companyId: string;
let otherCompanyId: string;
let projectId: string;
let vendorId: string;
let assignmentId: string;
let uploadRequestId: string;
let packageId: string;
let otherAssignmentId: string;

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

async function createSnapshot(userId: string, assignmentId: string) {
  const rows = await asUser<{ create_audit_snapshot: string }>(
    db,
    userId,
    `select public.create_audit_snapshot($1) as create_audit_snapshot`,
    [assignmentId],
  );
  return rows[0]!.create_audit_snapshot;
}

async function getSnapshotRow(id: string) {
  const result = await db.query<{
    id: string;
    requirements_snapshot: unknown;
    evidence_snapshot: { policies: unknown[]; deficiencies: unknown[]; exceptions: unknown[] };
  }>(
    `select id, requirements_snapshot, evidence_snapshot from public.audit_snapshots where id = $1`,
    [id],
  );
  return result.rows[0]!;
}

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@ridgeline.test", companyName: "Ridgeline GC" });
  companyId = await companyIdFor(db, OWNER);

  await signUp(db, { id: OTHER_OWNER, email: "owner@other.test", companyName: "Other Co" });
  otherCompanyId = await companyIdFor(db, OTHER_OWNER);

  // A default requirement_profiles row already exists for every new company
  // - seed_company_default_requirement_profile() (20260916000300_construction_core_expand.sql)
  // fires automatically on company creation (see handle_new_user()'s own
  // trigger chain) and requirement_profiles has a deferrable exclusion
  // constraint allowing only ONE is_company_default row per company, so
  // this test reuses that row rather than inserting a second one.
  const profile = await db.query<{ id: string }>(
    `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
    [companyId],
  );
  await db.query(
    `insert into public.requirement_profile_rules (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount, configuration)
     values ($1, $2, 'gl_each_occ', 'general_liability', 'limit', true, 2000000, '{"limitField":"each_occurrence"}'::jsonb)`,
    [companyId, profile.rows[0]!.id],
  );

  const project = await db.query<{ id: string }>(
    `insert into public.projects (company_id, name) values ($1, 'Reports Site') returning id`,
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
    `insert into public.project_vendor_assignments (company_id, project_id, vendor_id, trade_code)
     values ($1, $2, $3, 'Structural Steel') returning id`,
    [companyId, projectId, vendorId],
  );
  assignmentId = assignment.rows[0]!.id;

  const uploadRequest = await db.query<{ id: string }>(
    `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
     values ($1, $2, 'hash-reports', now() + interval '14 days') returning id`,
    [companyId, vendorId],
  );
  uploadRequestId = uploadRequest.rows[0]!.id;

  const pkg = await db.query<{ id: string }>(
    `insert into public.submission_packages (company_id, vendor_id, upload_request_id)
     values ($1, $2, $3) returning id`,
    [companyId, vendorId, uploadRequestId],
  );
  packageId = pkg.rows[0]!.id;

  // A second company's own project/vendor/assignment, for the cross-tenant
  // IDOR check on create_audit_snapshot().
  const otherProject = await db.query<{ id: string }>(
    `insert into public.projects (company_id, name) values ($1, 'Other Site') returning id`,
    [otherCompanyId],
  );
  const otherVendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Other Vendor', 'Electrical')
     returning id`,
    [otherCompanyId],
  );
  const otherAssignment = await db.query<{ id: string }>(
    `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
     values ($1, $2, $3) returning id`,
    [otherCompanyId, otherProject.rows[0]!.id, otherVendor.rows[0]!.id],
  );
  otherAssignmentId = otherAssignment.rows[0]!.id;
}, 60_000);

describe("create_audit_snapshot()", () => {
  it("writes an immutable snapshot capturing current requirements/evidence state", async () => {
    // A deficient run first, so the snapshot has a real deficiency in it.
    await applyResult(OWNER, { companyId, vendorId, assignmentId, uploadRequestId, packageId });

    const snapshotId = await createSnapshot(OWNER, assignmentId);
    const snapshot = await getSnapshotRow(snapshotId);

    const requirements = snapshot.requirements_snapshot as Array<{ key: string }>;
    expect(requirements.some((r) => r.key === "gl_each_occ")).toBe(true);

    const deficiencies = snapshot.evidence_snapshot.deficiencies as Array<{
      requirement_key: string;
      status: string;
    }>;
    expect(deficiencies).toHaveLength(1);
    expect(deficiencies[0]).toMatchObject({ requirement_key: "gl_each_occ", status: "open" });
  });

  it("a second snapshot taken after the underlying data changes captures the NEW state, not the old", async () => {
    const firstSnapshotId = await createSnapshot(OWNER, assignmentId);
    const firstSnapshot = await getSnapshotRow(firstSnapshotId);
    const firstDeficiencies = firstSnapshot.evidence_snapshot.deficiencies as Array<{
      status: string;
    }>;
    expect(firstDeficiencies[0]?.status).toBe("open");

    // Resolve the deficiency with a clean re-evaluation (no findings at all).
    await applyResult(OWNER, {
      companyId,
      vendorId,
      assignmentId,
      uploadRequestId,
      packageId,
      findings: [],
    });

    const secondSnapshotId = await createSnapshot(OWNER, assignmentId);
    const secondSnapshot = await getSnapshotRow(secondSnapshotId);
    const secondDeficiencies = secondSnapshot.evidence_snapshot.deficiencies as Array<{
      status: string;
    }>;
    expect(secondDeficiencies[0]?.status).toBe("resolved");

    // The FIRST snapshot's own row, re-read now, must still show the OLD
    // ('open') state - proving a snapshot is frozen at write time, not a
    // live view. This is the render-side guarantee (src/workflows/
    // auditSnapshots.ts's renderAuditSnapshotReport() only ever reads this
    // stored column, never re-queries) made directly observable in SQL: the
    // stored row itself never changes underneath a later data mutation.
    const firstSnapshotReread = await getSnapshotRow(firstSnapshotId);
    const firstDeficienciesReread = firstSnapshotReread.evidence_snapshot.deficiencies as Array<{
      status: string;
    }>;
    expect(firstDeficienciesReread[0]?.status).toBe("open");
  });

  it("refuses to snapshot another company's assignment (cross-tenant IDOR)", async () => {
    // Same generic "not authorized" anti-probing error every other
    // SECURITY DEFINER function in this schema raises for a cross-tenant id
    // (see apply_evaluation_result()'s own IDOR test in
    // compliance-cases.test.ts) - not an RLS policy denial, since this
    // function runs as postgres (rolbypassrls) and enforces authorization
    // itself as its first statement.
    await expect(createSnapshot(OWNER, otherAssignmentId)).rejects.toThrow(/not authorized/);
  });
});

describe("time-to-compliance report data (direct SQL, same join shape as getTimeToComplianceReport())", () => {
  it("computes the duration from first evaluation to resolution for a resolved deficiency", async () => {
    // Fresh assignment/case so this test's counts don't interact with the
    // describe block above's own mutations to the shared assignmentId.
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'TTC Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'TTC Vendor', 'Electrical')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );
    const uploadRequest = await db.query<{ id: string }>(
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'hash-ttc', now() + interval '14 days') returning id`,
      [companyId, vendor.rows[0]!.id],
    );
    const pkg = await db.query<{ id: string }>(
      `insert into public.submission_packages (company_id, vendor_id, upload_request_id)
       values ($1, $2, $3) returning id`,
      [companyId, vendor.rows[0]!.id, uploadRequest.rows[0]!.id],
    );

    const firstEvaluatedAt = "2026-01-01T00:00:00Z";
    await applyResult(OWNER, {
      companyId,
      vendorId: vendor.rows[0]!.id,
      assignmentId: assignment.rows[0]!.id,
      uploadRequestId: uploadRequest.rows[0]!.id,
      packageId: pkg.rows[0]!.id,
      evaluatedAt: firstEvaluatedAt,
    });
    // Clean resubmission resolves it.
    await applyResult(OWNER, {
      companyId,
      vendorId: vendor.rows[0]!.id,
      assignmentId: assignment.rows[0]!.id,
      uploadRequestId: uploadRequest.rows[0]!.id,
      packageId: pkg.rows[0]!.id,
      evaluatedAt: "2026-01-05T00:00:00Z",
      findings: [],
    });

    // Same join getTimeToComplianceReport() performs: resolved deficiencies
    // joined to their first_evaluation_run_id's evaluated_at.
    const result = await db.query<{
      requirement_key: string;
      resolved_at: string;
      evaluated_at: string;
    }>(
      `select d.requirement_key, d.resolved_at, r.evaluated_at
       from public.compliance_deficiencies d
       join public.compliance_evaluation_runs r on r.id = d.first_evaluation_run_id
       where d.company_id = $1 and d.status = 'resolved'
         and d.case_id in (select id from public.compliance_cases where assignment_id = $2)`,
      [companyId, assignment.rows[0]!.id],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.requirement_key).toBe("gl_each_occ");
    expect(new Date(result.rows[0]!.evaluated_at).toISOString().slice(0, 10)).toBe("2026-01-01");
    const durationHours =
      (new Date(result.rows[0]!.resolved_at).getTime() -
        new Date(result.rows[0]!.evaluated_at).getTime()) /
      (1000 * 60 * 60);
    expect(durationHours).toBeGreaterThan(0);
  });
});

describe("resubmissions report data (direct SQL, same join shape as getResubmissionsReport())", () => {
  it("counts more than one evaluation run on the same case as a resubmission", async () => {
    // The shared assignmentId/uploadRequestId above already got TWO
    // apply_evaluation_result() calls in the create_audit_snapshot()
    // describe block (the deficient run, then the clean resolving run) - so
    // its case already has 2 runs, exactly the "more than 1 run means a
    // resubmission occurred" property this report checks.
    const result = await db.query<{ case_id: string; run_count: string }>(
      `select c.id as case_id, count(r.id) as run_count
       from public.compliance_cases c
       join public.compliance_evaluation_runs r on r.case_id = c.id
       where c.company_id = $1 and c.assignment_id = $2
       group by c.id`,
      [companyId, assignmentId],
    );

    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0]!.run_count)).toBeGreaterThan(1);
  });
});

describe("missing vs. open deficiencies report data", () => {
  it("distinguishes no-evidence-at-all from present-but-insufficient evidence", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Missing Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Missing Vendor', 'Roofing')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );
    const uploadRequest = await db.query<{ id: string }>(
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'hash-missing', now() + interval '14 days') returning id`,
      [companyId, vendor.rows[0]!.id],
    );
    const pkg = await db.query<{ id: string }>(
      `insert into public.submission_packages (company_id, vendor_id, upload_request_id)
       values ($1, $2, $3) returning id`,
      [companyId, vendor.rows[0]!.id, uploadRequest.rows[0]!.id],
    );

    // One requirement with NO evidence (observed null), one with a
    // present-but-insufficient value (observed not null).
    await applyResult(OWNER, {
      companyId,
      vendorId: vendor.rows[0]!.id,
      assignmentId: assignment.rows[0]!.id,
      uploadRequestId: uploadRequest.rows[0]!.id,
      packageId: pkg.rows[0]!.id,
      requirements: [
        requirement({ key: "gl_each_occ" }),
        requirement({ key: "gl_agg", amount: 4000000 }),
      ],
      findings: [
        finding({ requirementKey: "gl_each_occ", observed: null }),
        finding({
          requirementKey: "gl_agg",
          observed: { amount: 1000000 },
          explanation: "Aggregate limit is below the required $4,000,000.",
        }),
      ],
    });

    // `observed is null` alone is NOT sufficient here: apply_evaluation_result()
    // stores a finding's JS `null` observed value as a JSONB json-null
    // LITERAL via the `->` operator, not SQL NULL - see
    // reportRepository.ts's fetchMissingDeficiencies() docblock for the full
    // explanation (found by this exact assertion originally coming back
    // empty). `observed = 'null'::jsonb` catches that case too.
    const missing = await db.query<{ requirement_key: string }>(
      `select requirement_key from public.compliance_deficiencies
       where case_id in (select id from public.compliance_cases where assignment_id = $1)
         and status = 'open'
         and (observed is null or observed = 'null'::jsonb)
         and kind in ('document', 'limit', 'endorsement')`,
      [assignment.rows[0]!.id],
    );
    const open = await db.query<{ requirement_key: string }>(
      `select requirement_key from public.compliance_deficiencies
       where case_id in (select id from public.compliance_cases where assignment_id = $1)
         and status = 'open'`,
      [assignment.rows[0]!.id],
    );

    expect(missing.rows.map((r) => r.requirement_key)).toEqual(["gl_each_occ"]);
    expect(open.rows.map((r) => r.requirement_key).sort()).toEqual(["gl_agg", "gl_each_occ"]);
  });
});
