import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * The tenancy boundary.
 *
 * These are the most important tests in the repo. A broken RLS policy does not
 * throw - it quietly returns rows it should not - so nothing else in the suite
 * would notice. `AdminGuard` and the role switcher are presentation only; this is
 * where the actual guarantee is checked.
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const READER = "33333333-3333-3333-3333-333333333333";
const STAFF = "44444444-4444-4444-4444-444444444444";

let db: PGlite;
let alicesCompany: string;
let bobsCompany: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: ALICE, email: "alice@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, { id: BOB, email: "bob@rival.test", companyName: "Rival Construction" });
  alicesCompany = await companyIdFor(db, ALICE);
  bobsCompany = await companyIdFor(db, BOB);

  await db.query(
    `insert into public.vendors (company_id, name, trade, project)
     values ($1, 'Corbett Structural Steel', 'Structural Steel', 'Harbor Point')`,
    [alicesCompany],
  );
  await db.query(
    `insert into public.vendors (company_id, name, trade, project)
     values ($1, 'Rival Sub', 'Roofing', 'Other Site')`,
    [bobsCompany],
  );

  await db.query(`insert into public.leads (company_name) values ('Secret Prospect')`);

  // A read-only member of Alice's company.
  await signUp(db, { id: READER, email: "reader@halstead.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only')`,
    [alicesCompany, READER],
  );

  // VendorClr staff.
  await signUp(db, { id: STAFF, email: "staff@vendorclear.test" });
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [STAFF]);
}, 60_000);

describe("cross-tenant reads", () => {
  it("shows each member only their own company's vendors", async () => {
    const alice = await asUser<{ name: string }>(db, ALICE, `select name from public.vendors`);
    const bob = await asUser<{ name: string }>(db, BOB, `select name from public.vendors`);

    expect(alice.map((r) => r.name)).toEqual(["Corbett Structural Steel"]);
    expect(bob.map((r) => r.name)).toEqual(["Rival Sub"]);
  });

  it("hides policies and compliance items across companies", async () => {
    await db.query(
      `insert into public.vendor_policies (company_id, vendor_id, policy_type, policy_number)
       select $1, id, 'general_liability', 'GL-SECRET' from public.vendors where company_id = $1`,
      [alicesCompany],
    );

    for (const table of ["vendor_policies", "vendor_compliance_items"]) {
      const rows = await asUser<{ n: number }>(
        db,
        BOB,
        `select count(*)::int n from public.${table} where company_id = $1`,
        [alicesCompany],
      );
      expect(rows[0]?.n, `${table} leaked across tenants`).toBe(0);
    }
  });

  it("hides another company's coverage requirements, company-wide as they are", async () => {
    await db.query(
      `insert into public.compliance_requirements
         (company_id, label, policy_type, limit_field, required_amount)
       values ($1, 'Secret requirement', 'general_liability', 'each_occurrence_limit', 2000000)`,
      [alicesCompany],
    );

    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.compliance_requirements where company_id = $1`,
      [alicesCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("applies RLS through views, not just base tables", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.company_report_rows`,
    );
    // security_invoker=true is what makes this hold.
    expect(rows[0]?.n).toBe(1);
  });

  it("keeps the sales pipeline invisible to customers", async () => {
    const rows = await asUser<{ n: number }>(db, ALICE, `select count(*)::int n from public.leads`);
    expect(rows[0]?.n).toBe(0);
  });
});

describe("cross-tenant writes", () => {
  it("refuses an insert naming another company", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        BOB,
        `insert into public.vendors (company_id, name, trade) values ($1, 'Injected', 'Roofing')`,
        [alicesCompany],
      ),
    );
  });

  it("refuses an update to another company's vendor", async () => {
    // Not an RLS error: the USING clause filters the row out, so this simply
    // updates nothing. Silent no-op is the correct, safe outcome.
    const updated = await asUser<{ id: string }>(
      db,
      BOB,
      `update public.vendors set name = 'Renamed' where company_id = $1 returning id`,
      [alicesCompany],
    );
    expect(updated).toEqual([]);

    const check = await asUser<{ name: string }>(db, ALICE, `select name from public.vendors`);
    expect(check.map((r) => r.name)).toEqual(["Corbett Structural Steel"]);
  });
});

describe("roles within a company", () => {
  it("lets a read_only member read", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      READER,
      `select count(*)::int n from public.vendors`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("stops a read_only member writing", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `insert into public.vendors (company_id, name, trade) values ($1, 'Nope', 'Roofing')`,
        [alicesCompany],
      ),
    );
  });
});

describe("platform staff", () => {
  it("reads across every company", async () => {
    const vendors = await asUser<{ n: number }>(
      db,
      STAFF,
      `select count(*)::int n from public.vendors`,
    );
    expect(vendors[0]?.n).toBe(2);

    const leads = await asUser<{ n: number }>(
      db,
      STAFF,
      `select count(*)::int n from public.leads`,
    );
    expect(leads[0]?.n).toBe(1);
  });

  it("may write the acting-company surface (vendors, tasks)", async () => {
    // "Act as company" (20261009180000): the vendors/tasks write policies are
    // widened with `... or is_platform_admin()` so staff can work inside a
    // customer's console. End-to-end CRUD is covered in
    // staff-act-as-company.test.ts; here we just pin the tenancy boundary.
    const inserted = await asUser<{ id: string }>(
      db,
      STAFF,
      `insert into public.vendors (company_id, name, trade)
       values ($1, 'Staff Wrote This', 'Roofing') returning id`,
      [alicesCompany],
    );
    expect(inserted[0]?.id).toBeTruthy();
  });

  it("still cannot write customer tables outside that surface", async () => {
    // Only vendors, tasks, contacts and upload requests are widened for staff.
    // Everything else stays members-only via can_write_company(), so a platform
    // admin (who is a member of no company) is still refused.
    await expectDeniedByRls(() =>
      asUser(
        db,
        STAFF,
        `insert into public.vendor_policies (company_id, vendor_id, policy_type, policy_number)
         select $1, id, 'general_liability', 'GL-STAFF' from public.vendors
         where company_id = $1 limit 1`,
        [alicesCompany],
      ),
    );
  });
});
