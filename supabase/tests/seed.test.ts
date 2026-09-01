import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, SEED_SQL, signUp } from "./harness";

const DEV_USER = "11111111-1111-1111-1111-111111111111";

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("seed.sql against an empty auth.users", () => {
  it("no-ops instead of erroring on a fresh db reset", async () => {
    await db.exec(SEED_SQL);

    const companies = await db.query<{ n: number }>(`select count(*)::int n from public.companies`);
    expect(companies.rows[0]?.n).toBe(0);
  });

  it("still seeds company-independent pipeline data", async () => {
    const leads = await db.query<{ n: number }>(`select count(*)::int n from public.leads`);
    expect(leads.rows[0]?.n).toBe(3);
  });
});

describe("seed.sql after a user signs up", () => {
  beforeAll(async () => {
    await signUp(db, { id: DEV_USER, email: "dev@halstead.test" });
    await db.exec(SEED_SQL);
  });

  it("attaches the demo company to the existing user as owner", async () => {
    const result = await db.query<{ name: string; role: string }>(`
      select c.name, m.role from public.companies c
      join public.company_members m on m.company_id = c.id
    `);
    expect(result.rows).toEqual([{ name: "Halstead Builders", role: "owner" }]);
  });

  it("seeds the demo vendor roster", async () => {
    const result = await db.query<{ name: string }>(
      `select name from public.vendors order by name`,
    );
    expect(result.rows.map((r) => r.name)).toEqual([
      "Corbett Structural Steel",
      "Delgado Concrete Works",
      "Rivera Electrical Contractors",
    ]);
  });

  it("gives one vendor several coverages from different carriers", async () => {
    const result = await db.query<{ policy_type: string; carrier_name: string }>(`
      select p.policy_type, p.carrier_name from public.vendor_policies p
      join public.vendors v on v.id = p.vendor_id
      where v.name = 'Corbett Structural Steel' order by p.policy_type
    `);

    expect(result.rows).toHaveLength(3);
    expect(new Set(result.rows.map((r) => r.carrier_name)).size).toBe(2);
  });

  it("reflects the seeded compliance states on the rail", async () => {
    const result = await db.query<{ requirement_key: string; status: string }>(`
      select ci.requirement_key, ci.status from public.vendor_compliance_items ci
      join public.vendors v on v.id = ci.vendor_id
      where v.name = 'Rivera Electrical Contractors'
    `);
    const byKey = Object.fromEntries(result.rows.map((r) => [r.requirement_key, r.status]));

    expect(byKey).toMatchObject({
      coi: "expiring",
      additionalInsured: "compliant",
      waiverOfSubrogation: "missing",
      lienWaiver: "compliant",
    });
  });

  it("is idempotent - re-running does not duplicate anything", async () => {
    await db.exec(SEED_SQL);

    const result = await db.query<{ companies: number; vendors: number; policies: number }>(`
      select
        (select count(*)::int from public.companies) companies,
        (select count(*)::int from public.vendors) vendors,
        (select count(*)::int from public.vendor_policies) policies
    `);

    expect(result.rows[0]).toEqual({ companies: 1, vendors: 3, policies: 6 });
  });

  it("produces sane aggregates for the reports and admin screens", async () => {
    const reports = await db.query<{ project: string }>(
      `select project from public.company_report_rows order by project`,
    );
    expect(reports.rows.map((r) => r.project)).toEqual([
      "Cedar Ridge Medical",
      "Harbor Point Tower B",
    ]);

    const stats = await db.query<{ vendor_count: number; seat_count: number }>(
      `select vendor_count, seat_count from public.admin_company_stats`,
    );
    expect(stats.rows[0]).toEqual({ vendor_count: 3, seat_count: 1 });
  });
});
