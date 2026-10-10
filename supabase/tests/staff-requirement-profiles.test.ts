import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * "Act as company": VendorClr staff configure a customer's requirement profiles
 * and rules (20261010000200). The write policies and
 * set_company_default_requirement_profile() are widened with
 * `... or is_platform_admin()`, so a platform admin (a member of no company)
 * can create a profile, add a rule, and set the company default; a plain
 * outsider stays refused.
 */

const STAFF = "a1111111-1111-1111-1111-111111111111";
const OWNER = "b2222222-2222-2222-2222-222222222222";
const OUTSIDER = "d4444444-4444-4444-4444-444444444444";

let db: PGlite;
let companyId: string;

beforeEach(async () => {
  db = await createTestDb();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [
    STAFF,
    "staff@vendorclr.com",
  ]);
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [STAFF]);
  await signUp(db, { id: OWNER, email: "owner@acme.test", companyName: "Acme" });
  await signUp(db, { id: OUTSIDER, email: "nobody@rival.test" });
  companyId = await companyIdFor(db, OWNER);
}, 60_000);

describe("staff requirement profiles on behalf", () => {
  it("lets a platform admin create a profile, add a rule, and set the default", async () => {
    const profile = await asUser<{ id: string }>(
      db,
      STAFF,
      `insert into public.requirement_profiles (company_id, name)
       values ($1, 'Managed defaults') returning id`,
      [companyId],
    );
    const profileId = profile[0]!.id;

    await asUser(
      db,
      STAFF,
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount)
       values ($1, $2, 'general_liability', 'general_liability', 'limit', true, 1000000)`,
      [companyId, profileId],
    );

    await asUser(db, STAFF, `select public.set_company_default_requirement_profile($1)`, [
      profileId,
    ]);

    const row = await db.query<{ is_company_default: boolean; rules: number }>(
      `select rp.is_company_default,
              (select count(*)::int from public.requirement_profile_rules r where r.profile_id = rp.id) as rules
       from public.requirement_profiles rp where rp.id = $1`,
      [profileId],
    );
    expect(row.rows[0]?.is_company_default).toBe(true);
    expect(row.rows[0]?.rules).toBe(1);
  });

  it("still refuses a non-staff outsider creating a profile", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        OUTSIDER,
        `insert into public.requirement_profiles (company_id, name) values ($1, 'Sneak')`,
        [companyId],
      ),
    );
  });
});
