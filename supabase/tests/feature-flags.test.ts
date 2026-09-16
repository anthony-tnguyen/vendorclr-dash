import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * company_feature_flags: per-company kill switches for flows that don't
 * exist yet (construction schema, requirement profiles, team invites,
 * submission packages, deficiency cases, exceptions, reports v2). Nothing
 * reads these in the app today - this suite only proves the storage and
 * access-control primitives behave: members see only their own company's
 * rows, no one can write directly, and set_company_feature_flag() is
 * platform-admin-only, same shape as signup-invites.test.ts's coverage of
 * create_signup_invite().
 */

const ADMIN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_A = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OWNER_B = "cccccccc-cccc-cccc-cccc-cccccccccccc";

let db: PGlite;
let companyA: string;
let companyB: string;

beforeEach(async () => {
  db = await createTestDb();

  await signUp(db, { id: ADMIN, email: "admin@vendorclear.test" });
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [ADMIN]);

  await signUp(db, { id: OWNER_A, email: "owner-a@coa.test", companyName: "Company A" });
  await signUp(db, { id: OWNER_B, email: "owner-b@cob.test", companyName: "Company B" });
  companyA = await companyIdFor(db, OWNER_A);
  companyB = await companyIdFor(db, OWNER_B);
}, 60_000);

describe("company_feature_flags defaults", () => {
  it("has no rows for a brand new company - every key reads as disabled", async () => {
    const rows = await db.query(
      `select 1 from public.company_feature_flags where company_id = $1`,
      [companyA],
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("company_feature_flags RLS: select", () => {
  it("lets a member read only their own company's flags, never another company's", async () => {
    await db.query(
      `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'construction_core', true)`,
      [companyA],
    );
    await db.query(
      `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'construction_core', true)`,
      [companyB],
    );

    const asOwnerA = await asUser<{ company_id: string; key: string }>(
      db,
      OWNER_A,
      `select company_id, key from public.company_feature_flags`,
    );
    expect(asOwnerA).toHaveLength(1);
    expect(asOwnerA[0]?.company_id).toBe(companyA);
  });

  it("lets a platform admin read every company's flags", async () => {
    await db.query(
      `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'construction_core', true)`,
      [companyA],
    );
    await db.query(
      `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'construction_core', true)`,
      [companyB],
    );

    const asAdmin = await asUser<{ company_id: string }>(
      db,
      ADMIN,
      `select company_id from public.company_feature_flags order by company_id`,
    );
    expect(asAdmin).toHaveLength(2);
  });
});

describe("company_feature_flags RLS: no direct writes for anyone", () => {
  it("denies an owner's direct insert", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        OWNER_A,
        `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'construction_core', true)`,
        [companyA],
      ),
    );
  });

  it("denies an owner's direct update, even on their own company's row", async () => {
    // Not expectDeniedByRls(): with no update policy defined, the USING
    // clause is simply "false" for every row, so the UPDATE's WHERE matches
    // zero rows and it succeeds without error rather than raising - same
    // shape as signup-invites.test.ts's "denies a non-admin's update". The
    // real assertion is that the row is provably unchanged afterward.
    await db.query(
      `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'construction_core', false)`,
      [companyA],
    );

    await asUser(
      db,
      OWNER_A,
      `update public.company_feature_flags set enabled = true where company_id = $1 and key = 'construction_core'`,
      [companyA],
    );

    const after = await db.query<{ enabled: boolean }>(
      `select enabled from public.company_feature_flags where company_id = $1 and key = 'construction_core'`,
      [companyA],
    );
    expect(after.rows[0]?.enabled).toBe(false);
  });

  it("denies an owner's direct delete", async () => {
    // Same reasoning as the update case above: no delete policy means the
    // DELETE's WHERE matches zero rows and succeeds as a no-op.
    await db.query(
      `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'construction_core', true)`,
      [companyA],
    );

    await asUser(
      db,
      OWNER_A,
      `delete from public.company_feature_flags where company_id = $1 and key = 'construction_core'`,
      [companyA],
    );

    const after = await db.query(
      `select 1 from public.company_feature_flags where company_id = $1 and key = 'construction_core'`,
      [companyA],
    );
    expect(after.rows).toHaveLength(1);
  });

  it("rejects an unknown flag key", async () => {
    await expect(
      db.query(
        `insert into public.company_feature_flags (company_id, key, enabled) values ($1, 'not_a_real_flag', true)`,
        [companyA],
      ),
    ).rejects.toThrow();
  });
});

describe("set_company_feature_flag()", () => {
  it("lets a platform admin enable a flag for any company", async () => {
    const rows = await asUser<{ company_id: string; key: string; enabled: boolean }>(
      db,
      ADMIN,
      `select company_id, key, enabled from public.set_company_feature_flag($1, $2, $3)`,
      [companyB, "construction_core", true],
    );
    expect(rows[0]).toMatchObject({
      company_id: companyB,
      key: "construction_core",
      enabled: true,
    });

    const stored = await db.query<{ enabled: boolean }>(
      `select enabled from public.company_feature_flags where company_id = $1 and key = 'construction_core'`,
      [companyB],
    );
    expect(stored.rows[0]?.enabled).toBe(true);
  });

  it("upserts - calling it again flips the same row rather than duplicating it", async () => {
    await asUser(db, ADMIN, `select public.set_company_feature_flag($1, $2, $3)`, [
      companyA,
      "team_invites",
      true,
    ]);
    await asUser(db, ADMIN, `select public.set_company_feature_flag($1, $2, $3)`, [
      companyA,
      "team_invites",
      false,
    ]);

    const rows = await db.query<{ enabled: boolean }>(
      `select enabled from public.company_feature_flags where company_id = $1 and key = 'team_invites'`,
      [companyA],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.enabled).toBe(false);
  });

  it("denies a company owner - platform-admin only, not company self-service", async () => {
    await expect(
      asUser(db, OWNER_A, `select public.set_company_feature_flag($1, $2, $3)`, [
        companyA,
        "construction_core",
        true,
      ]),
    ).rejects.toThrow(/not authorized/i);

    const stored = await db.query(
      `select 1 from public.company_feature_flags where company_id = $1 and key = 'construction_core'`,
      [companyA],
    );
    expect(stored.rows).toHaveLength(0);
  });

  it("denies a non-admin, non-member of the target company", async () => {
    await expect(
      asUser(db, OWNER_B, `select public.set_company_feature_flag($1, $2, $3)`, [
        companyA,
        "construction_core",
        true,
      ]),
    ).rejects.toThrow(/not authorized/i);
  });

  it("rejects an unknown flag key through the RPC too, not just a direct insert", async () => {
    await expect(
      asUser(db, ADMIN, `select public.set_company_feature_flag($1, $2, $3)`, [
        companyA,
        "not_a_real_flag",
        true,
      ]),
    ).rejects.toThrow();
  });
});
