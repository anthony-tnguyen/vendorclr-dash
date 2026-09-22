import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Task 11a - import_vendor_row() (20260917001500_vendor_import.sql). Each
 * call is one accepted CSV row's writes, atomically: project create-or-
 * lookup (matched by trimmed name, never overwriting an existing project's
 * certificate holder fields), vendor create-or-lookup (matched by normalized
 * name OR normalized non-empty email, never overwriting an existing
 * vendor's other fields), and an assignment create that is a no-op (not an
 * error) when the (project, vendor) pair already exists.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "44444444-4444-4444-4444-444444444444";
const READ_ONLY = "55555555-5555-5555-5555-555555555555";
const ENGINEER = "66666666-6666-6666-6666-666666666666";

let db: PGlite;
let companyId: string;
let otherCompanyId: string;

interface ImportVendorRowResult {
  project_id: string;
  project_created: boolean;
  vendor_id: string;
  vendor_created: boolean;
  assignment_id: string;
  assignment_created: boolean;
}

async function importRow(
  userId: string,
  args: {
    companyId: string;
    projectName: string;
    certificateHolderName?: string;
    certificateHolderAddress?: string;
    vendorName: string;
    trade?: string | null;
    contactName?: string;
    contactEmail?: string;
    riskTier?: string | null;
    contractValue?: number | null;
  },
): Promise<ImportVendorRowResult> {
  const rows = await asUser<ImportVendorRowResult>(
    db,
    userId,
    `select * from public.import_vendor_row($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      args.companyId,
      args.projectName,
      args.certificateHolderName ?? "",
      args.certificateHolderAddress ?? "",
      args.vendorName,
      args.trade ?? "Structural Steel",
      args.contactName ?? "",
      args.contactEmail ?? "",
      args.riskTier ?? "moderate",
      args.contractValue ?? 0,
    ],
  );
  return rows[0]!;
}

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@ridgeline.test", companyName: "Ridgeline GC" });
  companyId = await companyIdFor(db, OWNER);

  await signUp(db, { id: OTHER_OWNER, email: "owner@other.test", companyName: "Other Co" });
  otherCompanyId = await companyIdFor(db, OTHER_OWNER);

  await signUp(db, { id: READ_ONLY, email: "viewer@ridgeline.test" });
  await signUp(db, { id: ENGINEER, email: "pe@ridgeline.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only'), ($1, $3, 'project_engineer')`,
    [companyId, READ_ONLY, ENGINEER],
  );
}, 60_000);

describe("import_vendor_row()", () => {
  it("creates a brand-new project, vendor and assignment when none exist", async () => {
    const result = await importRow(OWNER, {
      companyId,
      projectName: "Harbor Tower",
      certificateHolderName: "Ridgeline GC LLC",
      certificateHolderAddress: "100 Harbor Way",
      vendorName: "Cascade Steel",
      trade: "Structural Steel",
      contactEmail: "ops@cascadesteel.test",
      contractValue: 500000,
    });

    expect(result.project_created).toBe(true);
    expect(result.vendor_created).toBe(true);
    expect(result.assignment_created).toBe(true);

    const project = await db.query<{ name: string; certificate_holder_name: string }>(
      `select name, certificate_holder_name from public.projects where id = $1`,
      [result.project_id],
    );
    expect(project.rows[0]).toMatchObject({
      name: "Harbor Tower",
      certificate_holder_name: "Ridgeline GC LLC",
    });

    const vendor = await db.query<{ name: string; trade: string }>(
      `select name, trade from public.vendors where id = $1`,
      [result.vendor_id],
    );
    expect(vendor.rows[0]).toMatchObject({ name: "Cascade Steel", trade: "Structural Steel" });

    const assignment = await db.query(
      `select id from public.project_vendor_assignments where id = $1`,
      [result.assignment_id],
    );
    expect(assignment.rows).toHaveLength(1);
  });

  it("reuses an existing project by normalized (trimmed) name match, without overwriting its certificate holder fields", async () => {
    const first = await importRow(OWNER, {
      companyId,
      projectName: "  Lakeside Campus  ",
      certificateHolderName: "Original Holder",
      certificateHolderAddress: "1 Original Ave",
      vendorName: "Vendor A For Lakeside",
    });
    expect(first.project_created).toBe(true);

    const second = await importRow(OWNER, {
      companyId,
      projectName: "Lakeside Campus",
      certificateHolderName: "Different Holder",
      certificateHolderAddress: "2 Different Ave",
      vendorName: "Vendor B For Lakeside",
    });

    expect(second.project_created).toBe(false);
    expect(second.project_id).toBe(first.project_id);

    const project = await db.query<{
      certificate_holder_name: string;
      certificate_holder_address: string;
    }>(
      `select certificate_holder_name, certificate_holder_address from public.projects where id = $1`,
      [first.project_id],
    );
    expect(project.rows[0]).toMatchObject({
      certificate_holder_name: "Original Holder",
      certificate_holder_address: "1 Original Ave",
    });
  });

  it("reuses an existing vendor by normalized name match (case/whitespace-insensitive), without overwriting its other fields", async () => {
    const first = await importRow(OWNER, {
      companyId,
      projectName: "Vendor Name Match Project",
      vendorName: "Acme Electrical Co",
      trade: "Electrical",
      contractValue: 250000,
      riskTier: "high",
    });
    expect(first.vendor_created).toBe(true);

    const second = await importRow(OWNER, {
      companyId,
      projectName: "Vendor Name Match Project Two",
      vendorName: "  acme electrical co  ",
      trade: "Concrete",
      contractValue: 999999,
      riskTier: "low",
    });

    expect(second.vendor_created).toBe(false);
    expect(second.vendor_id).toBe(first.vendor_id);

    const vendor = await db.query<{ trade: string; contract_value: number; risk_tier: string }>(
      `select trade, contract_value, risk_tier from public.vendors where id = $1`,
      [first.vendor_id],
    );
    expect(vendor.rows[0]).toMatchObject({
      trade: "Electrical",
      contract_value: 250000,
      risk_tier: "high",
    });
  });

  it("reuses an existing vendor by normalized email match even if the name differs", async () => {
    const first = await importRow(OWNER, {
      companyId,
      projectName: "Email Match Project",
      vendorName: "Beacon Roofing Inc",
      contactEmail: "billing@beaconroofing.test",
      trade: "Roofing",
    });
    expect(first.vendor_created).toBe(true);

    const second = await importRow(OWNER, {
      companyId,
      projectName: "Email Match Project Two",
      vendorName: "Beacon Roofing (renamed)",
      contactEmail: "  Billing@BeaconRoofing.test  ",
      trade: "Roofing",
    });

    expect(second.vendor_created).toBe(false);
    expect(second.vendor_id).toBe(first.vendor_id);

    const vendor = await db.query<{ name: string }>(
      `select name from public.vendors where id = $1`,
      [first.vendor_id],
    );
    expect(vendor.rows[0]!.name).toBe("Beacon Roofing Inc");
  });

  it("calling it twice for the SAME (project, vendor) pair does not error and does not create a second assignment", async () => {
    const first = await importRow(OWNER, {
      companyId,
      projectName: "Idempotent Assignment Project",
      vendorName: "Idempotent Assignment Vendor",
    });

    const second = await importRow(OWNER, {
      companyId,
      projectName: "Idempotent Assignment Project",
      vendorName: "Idempotent Assignment Vendor",
    });

    expect(second.project_id).toBe(first.project_id);
    expect(second.vendor_id).toBe(first.vendor_id);
    expect(second.assignment_id).toBe(first.assignment_id);
    expect(second.assignment_created).toBe(false);

    const assignments = await db.query(
      `select id from public.project_vendor_assignments where project_id = $1 and vendor_id = $2`,
      [first.project_id, first.vendor_id],
    );
    expect(assignments.rows).toHaveLength(1);
  });

  it("raises for a cross-tenant company id (IDOR)", async () => {
    await expect(
      importRow(OTHER_OWNER, {
        companyId,
        projectName: "Cross Tenant Project",
        vendorName: "Cross Tenant Vendor",
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it("refuses a read_only member and writes nothing - same write roles as the direct table policies (20260922140000)", async () => {
    await expect(
      importRow(READ_ONLY, {
        companyId,
        projectName: "Read Only Project",
        vendorName: "Read Only Vendor",
      }),
    ).rejects.toThrow(/not authorized/);

    const written = await db.query<{ n: number }>(
      `select (select count(*) from public.projects where name = 'Read Only Project')
            + (select count(*) from public.vendors where name = 'Read Only Vendor') as n`,
    );
    expect(Number(written.rows[0]!.n)).toBe(0);
  });

  it("still lets a project_engineer import", async () => {
    const result = await importRow(ENGINEER, {
      companyId,
      projectName: "Engineer Project",
      vendorName: "Engineer Vendor",
    });
    expect(result).toMatchObject({
      project_created: true,
      vendor_created: true,
      assignment_created: true,
    });
  });

  it("rejects an invalid trade value via the existing CHECK constraint, not silent coercion", async () => {
    await expect(
      importRow(OWNER, {
        companyId,
        projectName: "Bad Trade Project",
        vendorName: "Bad Trade Vendor",
        trade: "Not A Real Trade",
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid risk_tier value via the existing CHECK constraint, not silent coercion", async () => {
    await expect(
      importRow(OWNER, {
        companyId,
        projectName: "Bad Risk Tier Project",
        vendorName: "Bad Risk Tier Vendor",
        riskTier: "extreme",
      }),
    ).rejects.toThrow();
  });
});
