import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { companyIdFor, createTestDb, readMigration, signUp } from "./harness";

/**
 * The one-shot backfill (20260916000400_construction_core_backfill.sql).
 *
 * createTestDb() applies every migration, backfill included, against an empty
 * database - there is no legacy data yet at that point, so the backfill is
 * necessarily a no-op there (exactly like the live project's own current
 * state, see the task's live-application notes). To actually exercise the
 * backfill's data-migration logic this suite seeds vendors/compliance_requirements
 * the way a pre-Task-4 production database would look, then re-executes the
 * migration file's own SQL a second time by hand - once to backfill that
 * data, and again immediately after to prove it is safe to re-run (the
 * Definition of Done's "repeatable" requirement) without duplicating
 * anything.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const BACKFILL_MIGRATION = "20260916000400_construction_core_backfill.sql";

let db: PGlite;
let companyId: string;

async function runBackfill(): Promise<void> {
  await db.exec(readMigration(BACKFILL_MIGRATION));
}

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);

  // Legacy-shaped vendor data: two vendors sharing a real project, one
  // "Unassigned" (the default - not a real project), one with a
  // whitespace-only project name (also not real once trimmed), and one whose
  // project name differs only by surrounding whitespace from another vendor's
  // - both must land on the SAME projects row.
  await db.query(
    `insert into public.vendors (company_id, name, trade, project, contract_value, risk_tier)
     values
       ($1, 'Corbett Steel', 'Structural Steel', 'Harbor Point Tower B', 4820000, 'high'),
       ($1, 'Rivera Electrical', 'Electrical', '  Harbor Point Tower B  ', 2140000, 'moderate'),
       ($1, 'No Project Sub', 'Roofing', 'Unassigned', 0, 'moderate'),
       ($1, 'Blank Project Sub', 'Glazing', '   ', 0, 'low')`,
    [companyId],
  );

  // Two compliance_requirements rows that collide on (policy_type,
  // limit_field) once derived into a rule_key - compliance_requirements'
  // own unique(company_id, label) does not prevent this.
  await db.query(
    `insert into public.compliance_requirements (company_id, label, policy_type, limit_field, required_amount, created_at)
     values
       ($1, 'GL primary', 'general_liability', 'each_occurrence_limit', 1000000, now() - interval '1 day'),
       ($1, 'GL duplicate', 'general_liability', 'each_occurrence_limit', 2000000, now())`,
    [companyId],
  );
}, 60_000);

describe("construction_core backfill", () => {
  it("creates one project per distinct trimmed project name, excluding Unassigned/blank", async () => {
    await runBackfill();

    const projects = await db.query<{ name: string }>(
      `select name from public.projects where company_id = $1 order by name`,
      [companyId],
    );
    expect(projects.rows.map((r) => r.name)).toEqual(["Harbor Point Tower B"]);
  });

  it("creates one assignment per named-project vendor, copying contract_value/trade/risk_tier", async () => {
    const assignments = await db.query<{
      vendor_name: string;
      contract_value: number;
      trade_code: string;
      risk_classification: string;
    }>(
      `select v.name as vendor_name, a.contract_value, a.trade_code, a.risk_classification
       from public.project_vendor_assignments a
       join public.vendors v on v.id = a.vendor_id
       where a.company_id = $1
       order by v.name`,
      [companyId],
    );

    expect(assignments.rows).toEqual([
      {
        vendor_name: "Corbett Steel",
        contract_value: 4820000,
        trade_code: "Structural Steel",
        risk_classification: "high",
      },
      {
        vendor_name: "Rivera Electrical",
        contract_value: 2140000,
        trade_code: "Electrical",
        risk_classification: "moderate",
      },
    ]);
  });

  it("never touches the vendors table - no vendor row is duplicated", async () => {
    const vendors = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendors where company_id = $1`,
      [companyId],
    );
    expect(vendors.rows[0]?.n).toBe(4);
  });

  it("seeds exactly one company-default profile and converts compliance_requirements to rules", async () => {
    const profiles = await db.query<{ n: number }>(
      `select count(*)::int n from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );
    expect(profiles.rows[0]?.n).toBe(1);

    // The collision resolves deterministically to the OLDER compliance_requirements
    // row (created_at ascending), not an arbitrary one.
    const rule = await db.query<{ amount: number }>(
      `select amount
       from public.requirement_profile_rules
       where company_id = $1 and rule_key = 'general_liability_each_occurrence_limit'`,
      [companyId],
    );
    expect(rule.rows).toHaveLength(1);
    expect(rule.rows[0]?.amount).toBe(1000000);
  });

  it("is idempotent: re-running the migration inserts nothing new", async () => {
    const before = await Promise.all([
      db.query<{ n: number }>(`select count(*)::int n from public.projects where company_id = $1`, [
        companyId,
      ]),
      db.query<{ n: number }>(
        `select count(*)::int n from public.project_vendor_assignments where company_id = $1`,
        [companyId],
      ),
      db.query<{ n: number }>(
        `select count(*)::int n from public.requirement_profiles where company_id = $1`,
        [companyId],
      ),
      db.query<{ n: number }>(
        `select count(*)::int n from public.requirement_profile_rules where company_id = $1`,
        [companyId],
      ),
    ]);

    await runBackfill();
    await runBackfill();

    const after = await Promise.all([
      db.query<{ n: number }>(`select count(*)::int n from public.projects where company_id = $1`, [
        companyId,
      ]),
      db.query<{ n: number }>(
        `select count(*)::int n from public.project_vendor_assignments where company_id = $1`,
        [companyId],
      ),
      db.query<{ n: number }>(
        `select count(*)::int n from public.requirement_profiles where company_id = $1`,
        [companyId],
      ),
      db.query<{ n: number }>(
        `select count(*)::int n from public.requirement_profile_rules where company_id = $1`,
        [companyId],
      ),
    ]);

    for (let i = 0; i < before.length; i += 1) {
      expect(after[i]!.rows[0]?.n).toBe(before[i]!.rows[0]?.n);
    }
  });

  describe("reconciliation", () => {
    it("(1) distinct non-Unassigned (company, name) pairs among vendors == projects created", async () => {
      const result = await db.query<{ expected: number; actual: number }>(
        `select
           (select count(*) from (
             select distinct company_id, btrim(project) as name
             from public.vendors
             where btrim(project) <> '' and btrim(project) <> 'Unassigned'
           ) pairs) as expected,
           (select count(*) from public.projects) as actual`,
      );
      expect(result.rows[0]?.actual).toBe(result.rows[0]?.expected);
      expect(result.rows[0]?.actual).toBe(1);
    });

    it("(2) vendors with a non-Unassigned project == assignments created", async () => {
      const result = await db.query<{ expected: number; actual: number }>(
        `select
           (select count(*) from public.vendors
            where btrim(project) <> '' and btrim(project) <> 'Unassigned') as expected,
           (select count(*) from public.project_vendor_assignments) as actual`,
      );
      expect(result.rows[0]?.actual).toBe(result.rows[0]?.expected);
      expect(result.rows[0]?.actual).toBe(2);
    });

    it("(3) every child row's company_id matches its parent chain", async () => {
      const result = await db.query<{ table_name: string }>(
        `select 'project_vendor_assignments' as table_name, a.id
         from public.project_vendor_assignments a
         join public.projects p on p.id = a.project_id
         join public.vendors v on v.id = a.vendor_id
         where a.company_id <> p.company_id or a.company_id <> v.company_id
         union all
         select 'requirement_profile_rules', r.id
         from public.requirement_profile_rules r
         join public.requirement_profiles rp on rp.id = r.profile_id
         where r.company_id <> rp.company_id`,
      );
      expect(result.rows).toEqual([]);
    });

    it("(4) every backfilled rule amount matches its source compliance_requirements row (or the deterministic winner among collisions)", async () => {
      const result = await db.query<{ n: number }>(
        `select count(*)::int n
         from public.requirement_profile_rules r
         join public.requirement_profiles rp on rp.id = r.profile_id and rp.is_company_default
         join public.compliance_requirements cr
           on cr.company_id = r.company_id
           and cr.policy_type || '_' || cr.limit_field = r.rule_key
           and cr.required_amount = r.amount
         where r.company_id = $1`,
        [companyId],
      );
      // At least one matching source row exists for every backfilled rule
      // (the winner of the collision, by construction).
      expect(result.rows[0]?.n).toBeGreaterThanOrEqual(1);
    });
  });
});
