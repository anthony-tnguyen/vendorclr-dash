import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * admin_create_vendor (20261009140000): staff add a vendor on a customer
 * company's behalf. Gated on is_platform_admin(); vendors_insert itself is not
 * widened. The after-insert triggers still seed the five compliance rows.
 */

const STAFF = "a1111111-1111-1111-1111-111111111111";
const OWNER = "b2222222-2222-2222-2222-222222222222";
const OUTSIDER = "d4444444-4444-4444-4444-444444444444";
const MISSING_COMPANY = "99999999-9999-9999-9999-999999999999";

let db: PGlite;
let companyId: string;

async function raiseMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

beforeEach(async () => {
  db = await createTestDb();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [
    STAFF,
    "staff@vendorclr.com",
  ]);
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [STAFF]);
  await signUp(db, { id: OWNER, email: "owner@acme.test", companyName: "Acme" });
  await signUp(db, { id: OUTSIDER, email: "nobody@acme.test" });
  companyId = await companyIdFor(db, OWNER);
}, 60_000);

describe("admin_create_vendor", () => {
  it("lets staff add a vendor to a company, with compliance rows seeded", async () => {
    await asUser(
      db,
      STAFF,
      `select public.admin_create_vendor($1, 'Bay Steel', 'Structural Steel', 'Pier 7', 500000, 'Sam', 'sam@bay.test')`,
      [companyId],
    );

    const vendor = await db.query<{ id: string; company_id: string; project: string }>(
      `select id, company_id, project from public.vendors where name = 'Bay Steel'`,
    );
    expect(vendor.rows[0]?.company_id).toBe(companyId);
    expect(vendor.rows[0]?.project).toBe("Pier 7");

    const items = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_compliance_items where vendor_id = $1`,
      [vendor.rows[0]!.id],
    );
    expect(items.rows[0]?.n).toBe(5);
  });

  it("defaults project to Unassigned when blank", async () => {
    await asUser(
      db,
      STAFF,
      `select public.admin_create_vendor($1, 'No Project Co', 'Roofing', '')`,
      [companyId],
    );
    const vendor = await db.query<{ project: string }>(
      `select project from public.vendors where name = 'No Project Co'`,
    );
    expect(vendor.rows[0]?.project).toBe("Unassigned");
  });

  it("refuses a non-staff caller", async () => {
    const message = await raiseMessage(() =>
      asUser(db, OUTSIDER, `select public.admin_create_vendor($1, 'Nope', 'Electrical')`, [
        companyId,
      ]),
    );
    expect(message).toMatch(/not authorized/i);
    const count = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendors where name = 'Nope'`,
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it("rejects an unknown company", async () => {
    const message = await raiseMessage(() =>
      asUser(db, STAFF, `select public.admin_create_vendor($1, 'Ghost', 'Concrete')`, [
        MISSING_COMPANY,
      ]),
    );
    expect(message).toMatch(/company not found/i);
  });

  it("rejects an unknown trade via the table constraint", async () => {
    const message = await raiseMessage(() =>
      asUser(
        db,
        STAFF,
        `select public.admin_create_vendor($1, 'Odd Trade Co', 'Underwater Basket')`,
        [companyId],
      ),
    );
    expect(message).toMatch(/violates check constraint|vendors_trade_check/i);
  });
});
