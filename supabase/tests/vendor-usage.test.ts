import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * company_vendor_usage() (20260929000100, fixed in 20261009000400).
 *
 * Regression guard for the shipped 42703: the function's membership check read
 * `select company_id from public.current_company_ids()`, but that function
 * returns `setof uuid`, so every authorized call raised
 * `column "company_id" does not exist` at runtime. These tests INVOKE the
 * function as a signed-in user - exactly what the repository's getVendorUsage()
 * does - rather than only asserting it exists, because the defect was purely a
 * runtime one (plpgsql bodies are not validated at creation time).
 */

const OWNER = "a1111111-1111-1111-1111-111111111111";
const OUTSIDER = "b2222222-2222-2222-2222-222222222222";

type UsageRow = {
  active_vendors: number;
  max_active_vendors: number | null;
  utilization: string | number;
};

let db: PGlite;

beforeEach(async () => {
  db = await createTestDb();
  // signUp creates a company on the default plan ('core' -> 75 active-vendor ceiling).
  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, { id: OUTSIDER, email: "outsider@example.test" });
});

describe("company_vendor_usage", () => {
  it("returns usage for a member without raising (regression: 42703 on current_company_ids)", async () => {
    const companyId = await companyIdFor(db, OWNER);

    const rows = await asUser<UsageRow>(
      db,
      OWNER,
      `select * from public.company_vendor_usage($1)`,
      [companyId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.active_vendors).toBe(0);
    expect(rows[0]!.max_active_vendors).toBe(75); // core plan ceiling
    expect(Number(rows[0]!.utilization)).toBe(0);
  });

  it("counts only non-archived vendors and computes utilization against the ceiling", async () => {
    const companyId = await companyIdFor(db, OWNER);

    // Three active vendors + one archived; only the three active ones count.
    await db.query(
      `insert into public.vendors (company_id, name, trade, archived_at) values
         ($1, 'Active One',   'Electrical', null),
         ($1, 'Active Two',   'Electrical', null),
         ($1, 'Active Three', 'Electrical', null),
         ($1, 'Archived One', 'Electrical', now())`,
      [companyId],
    );

    const rows = await asUser<UsageRow>(
      db,
      OWNER,
      `select * from public.company_vendor_usage($1)`,
      [companyId],
    );

    expect(rows[0]!.active_vendors).toBe(3);
    expect(rows[0]!.max_active_vendors).toBe(75);
    expect(Number(rows[0]!.utilization)).toBeCloseTo(3 / 75, 4);
  });

  it("denies a caller who is not a member of the target company", async () => {
    const companyId = await companyIdFor(db, OWNER);

    await expect(
      asUser(db, OUTSIDER, `select * from public.company_vendor_usage($1)`, [companyId]),
    ).rejects.toThrow(/not authorized/i);
  });
});
