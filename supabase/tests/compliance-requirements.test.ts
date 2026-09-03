import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * compliance_requirements (migration 13) - company-wide coverage
 * requirements. Company-wide, not vendor-scoped (see the migration's
 * docblock), so the RLS boundary this suite matters most for is the
 * standard can_write_company() one - the same shape every other writable
 * table in this schema already uses - not anything vendor-specific.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const READER = "22222222-2222-2222-2222-222222222222";
const RIVAL_OWNER = "33333333-3333-3333-3333-333333333333";

let db: PGlite;
let companyId: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, {
    id: RIVAL_OWNER,
    email: "owner@rival.test",
    companyName: "Rival Construction",
  });
  companyId = await companyIdFor(db, OWNER);

  await signUp(db, { id: READER, email: "reader@halstead.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only')`,
    [companyId, READER],
  );
}, 60_000);

describe("compliance_requirements", () => {
  it("lets a write-role member create a requirement for their own company", async () => {
    const rows = await asUser<{ label: string }>(
      db,
      OWNER,
      `insert into public.compliance_requirements
         (company_id, label, policy_type, limit_field, required_amount)
       values ($1, 'General liability / occurrence', 'general_liability', 'each_occurrence_limit', 2000000)
       returning label`,
      [companyId],
    );
    expect(rows[0]?.label).toBe("General liability / occurrence");
  });

  it("refuses a read_only member creating one", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `insert into public.compliance_requirements
           (company_id, label, policy_type, limit_field, required_amount)
         values ($1, 'Reader attempt', 'general_liability', 'each_occurrence_limit', 1)`,
        [companyId],
      ),
    );
  });

  it("rejects a policy_type outside the allowed set", async () => {
    await expect(
      db.query(
        `insert into public.compliance_requirements
           (company_id, label, policy_type, limit_field, required_amount)
         values ($1, 'Bad type', 'flood', 'each_occurrence_limit', 1)`,
        [companyId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a limit_field outside each_occurrence_limit/general_aggregate_limit", async () => {
    await expect(
      db.query(
        `insert into public.compliance_requirements
           (company_id, label, policy_type, limit_field, required_amount)
         values ($1, 'Bad field', 'general_liability', 'deductible', 1)`,
        [companyId],
      ),
    ).rejects.toThrow();
  });

  it("enforces one label per company (a collision must not silently duplicate)", async () => {
    await db.query(
      `insert into public.compliance_requirements
         (company_id, label, policy_type, limit_field, required_amount)
       values ($1, 'Workers compensation', 'workers_compensation', 'each_occurrence_limit', 1000000)`,
      [companyId],
    );
    await expect(
      db.query(
        `insert into public.compliance_requirements
           (company_id, label, policy_type, limit_field, required_amount)
         values ($1, 'Workers compensation', 'workers_compensation', 'each_occurrence_limit', 1500000)`,
        [companyId],
      ),
    ).rejects.toThrow();
  });

  it("is invisible to a different company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.compliance_requirements where company_id = $1`,
      [companyId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
