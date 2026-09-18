import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, createTestDb, readMigration } from "./harness";

/**
 * The paid-access model: signup is open and lands on a demo workspace, and a
 * code issued by staff after payment is the only thing that turns it into a
 * customer's real one.
 */

const STAFF = "a1111111-1111-1111-1111-111111111111";
const BUYER = "b2222222-2222-2222-2222-222222222222";
const NEIGHBOR = "c3333333-3333-3333-3333-333333333333";
const REUSER = "d4444444-4444-4444-4444-444444444444";

let db: PGlite;

/** Inserts into auth.users, which fires handle_new_user exactly as signup does. */
async function makeUser(id: string, email: string): Promise<void> {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
}

async function makeStaff(id: string, email: string): Promise<void> {
  await makeUser(id, email);
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [id]);
}

async function issue(
  as: string,
  email: string,
  companyName: string,
  plan = "Field",
): Promise<{ id: string; code: string; status: string }> {
  const rows = await asUser<{ id: string; code: string; status: string }>(
    db,
    as,
    `select id, code, status from public.create_activation_code($1, $2, $3, $4, $5)`,
    [email, companyName, plan, null, null],
  );
  const row = rows[0];
  if (!row) throw new Error("create_activation_code returned no row");
  return row;
}

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select count(*)::text as n from public.${table} where ${where}`,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** The message a statement raises, or a failure of the test if it succeeds. */
async function raiseMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

describe("activation codes (20260918000200)", () => {
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("leaves a new signup with a profile and no company", async () => {
    await makeUser(BUYER, "rosa@halstead.test");

    expect(await count("profiles", "id = 'b2222222-2222-2222-2222-222222222222'")).toBe(1);
    expect(await count("company_members", "user_id = 'b2222222-2222-2222-2222-222222222222'")).toBe(
      0,
    );
    expect(await count("companies")).toBe(0);
  });

  it("lets staff issue a code and refuses everyone else", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");

    const code = await issue(STAFF, "rosa@halstead.test", "Halstead Builders", "Program");
    expect(code.status).toBe("pending");
    // The generated alphabet drops I, L, O, U, 0 and 1 so a code read over the
    // phone cannot be mis-typed into a different one.
    expect(code.code).toMatch(/^[A-Z]{10}$/);
    expect(code.code).not.toMatch(/[ILOU01]/);

    const refused = await raiseMessage(() =>
      asUser(db, BUYER, `select public.create_activation_code($1, $2)`, ["x@y.test", "X"]),
    );
    expect(refused).toMatch(/not authorized/i);
  });

  it("keeps codes invisible to customers and unwritable for anyone", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    await issue(STAFF, "rosa@halstead.test", "Halstead Builders");

    expect(await asUser(db, STAFF, `select code from public.activation_codes`)).toHaveLength(1);
    expect(await asUser(db, BUYER, `select code from public.activation_codes`)).toHaveLength(0);

    // Staff write through create_activation_code only. There is no INSERT grant
    // and no write policy, so even a platform admin cannot edit a row by hand -
    // which is what keeps "used" from becoming a suggestion.
    const direct = await raiseMessage(() =>
      asUser(
        db,
        STAFF,
        `insert into public.activation_codes (code, email, company_name) values ('ZZZZZZZZZZ', 'a@b.test', 'Direct')`,
      ),
    );
    expect(direct).toMatch(/permission denied|row-level security/i);
  });

  it("opens a fresh activated workspace for the named email only", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    await makeUser(NEIGHBOR, "rosa@other.test");

    const { code } = await issue(STAFF, "rosa@halstead.test", "Halstead Builders");

    const wrongMailbox = await raiseMessage(() =>
      asUser(db, NEIGHBOR, `select id from public.redeem_activation_code($1)`, [code]),
    );
    expect(wrongMailbox).toMatch(/not recognised/i);

    const opened = await asUser<{
      name: string;
      plan: string;
      activation_status: string;
      subscription_renews_on: string | null;
    }>(
      db,
      BUYER,
      `select name, plan, activation_status, subscription_renews_on from public.redeem_activation_code($1)`,
      [code],
    );
    expect(opened[0]).toMatchObject({
      name: "Halstead Builders",
      plan: "Field",
      activation_status: "activated",
    });

    const membership = await asUser<{ role: string }>(
      db,
      BUYER,
      `select role from public.company_members`,
    );
    expect(membership[0]?.role).toBe("owner");

    // The code is spent, and the workspace it opened is not the demo one.
    const spent = await db.query<{ status: string; used_by: string | null }>(
      `select status, used_by from public.activation_codes`,
    );
    expect(spent.rows[0]?.status).toBe("used");
    expect(spent.rows[0]?.used_by).toBe(BUYER);
  });

  it("refuses a second workspace for an account that already has one", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    const first = await issue(STAFF, "rosa@halstead.test", "Halstead Builders");
    const second = await issue(STAFF, "rosa@halstead.test", "Halstead Second");

    await asUser(db, BUYER, `select id from public.redeem_activation_code($1)`, [first.code]);

    const again = await raiseMessage(() =>
      asUser(db, BUYER, `select id from public.redeem_activation_code($1)`, [second.code]),
    );
    expect(again).toMatch(/already has a VendorClr workspace/i);
    expect(await count("companies")).toBe(1);
  });

  it("refuses a used code from an account with no workspace", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    await makeUser(REUSER, "other@halstead.test");
    const { code } = await issue(STAFF, "rosa@halstead.test", "Halstead Builders");

    await asUser(db, BUYER, `select id from public.redeem_activation_code($1)`, [code]);

    const reuse = await raiseMessage(() =>
      asUser(db, REUSER, `select id from public.redeem_activation_code($1)`, [code]),
    );
    // Identical to "that code does not exist": the form cannot be used to find
    // out whether a code someone typed is real.
    expect(reuse).toMatch(/not recognised/i);
  });

  it("records the redemption in the audit log", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    const { code } = await issue(STAFF, "rosa@halstead.test", "Halstead Builders");

    await asUser(db, BUYER, `select id from public.redeem_activation_code($1)`, [code]);

    const actions = await db.query<{ action: string }>(
      `select action from public.audit_log order by created_at`,
    );
    expect(actions.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["activation_code_redeemed", "company_activated"]),
    );
  });

  it("closes and reopens a workspace without deleting it", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    const { code } = await issue(STAFF, "rosa@halstead.test", "Halstead Builders");
    await asUser(db, BUYER, `select id from public.redeem_activation_code($1)`, [code]);

    const company = await db.query<{ id: string }>(`select id from public.companies`);
    const companyId = company.rows[0]!.id;

    const closed = await asUser<{ activation_status: string }>(
      db,
      STAFF,
      `select activation_status from public.set_company_activation($1, 'revoked')`,
      [companyId],
    );
    expect(closed[0]?.activation_status).toBe("revoked");

    // Closing is a door, not a shredder: the roster and the membership survive,
    // so a customer who pays again picks the same workspace back up.
    expect(await count("company_members", "company_id = $1", [companyId])).toBe(1);
    expect(await count("company_members")).toBe(1);

    const reopened = await asUser<{ activation_status: string }>(
      db,
      STAFF,
      `select activation_status from public.set_company_activation($1, 'activated')`,
      [companyId],
    );
    expect(reopened[0]?.activation_status).toBe("activated");
  });

  it("refuses a customer changing their own activation", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    const { code } = await issue(STAFF, "rosa@halstead.test", "Halstead Builders");
    await asUser(db, BUYER, `select id from public.redeem_activation_code($1)`, [code]);

    const company = await db.query<{ id: string }>(`select id from public.companies`);

    const selfServe = await raiseMessage(() =>
      asUser(db, BUYER, `select public.set_company_activation($1, 'activated')`, [
        company.rows[0]!.id,
      ]),
    );
    expect(selfServe).toMatch(/not authorized/i);
  });

  it("withdraws an unused code and refuses it afterwards", async () => {
    await makeStaff(STAFF, "ops@vendorclr.test");
    await makeUser(BUYER, "rosa@halstead.test");
    const { id, code } = await issue(STAFF, "rosa@halstead.test", "Halstead Builders");

    const withdrawn = await asUser<{ status: string }>(
      db,
      STAFF,
      `select status from public.revoke_activation_code($1)`,
      [id],
    );
    expect(withdrawn[0]?.status).toBe("revoked");

    const entered = await raiseMessage(() =>
      asUser(db, BUYER, `select id from public.redeem_activation_code($1)`, [code]),
    );
    expect(entered).toMatch(/not recognised/i);

    const twice = await raiseMessage(() =>
      asUser(db, STAFF, `select public.revoke_activation_code($1)`, [id]),
    );
    expect(twice).toMatch(/only a pending activation code/i);
  });

  it("counts companies that existed before the migration as paid", async () => {
    // A separate database stopped just before this migration, because the
    // backfill has to run against a schema that already has customers in it -
    // which is exactly the state the live project was in when this migration
    // was applied.
    const existing = await createTestDb({
      stopBeforeMigration: "20260918000200_activation_codes.sql",
    });
    await existing.query(`insert into public.companies (name, plan) values ('Legacy Co', 'Field')`);
    await existing.exec(readMigration("20260918000200_activation_codes.sql"));

    const rows = await existing.query<{ activation_status: string }>(
      `select activation_status from public.companies`,
    );
    expect(rows.rows[0]?.activation_status).toBe("activated");

    await existing.close();
  });
});
