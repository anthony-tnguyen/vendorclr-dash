import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Staff account & company management RPCs
 * (20261009120000_admin_account_and_company_management.sql).
 *
 * Each is SECURITY DEFINER and gated on is_platform_admin(); the guards (last
 * owner kept, no self-revoke) are enforced in the function, with
 * company_members_guard_last_owner_trg as the backstop. These run as a
 * signed-in user via asUser so the is_platform_admin() check sees a real
 * auth.uid().
 */

const STAFF = "a1111111-1111-1111-1111-111111111111";
const OWNER = "b2222222-2222-2222-2222-222222222222";
const SECOND = "c3333333-3333-3333-3333-333333333333";
const OUTSIDER = "d4444444-4444-4444-4444-444444444444";

let db: PGlite;

async function makeStaff(id: string, email: string): Promise<void> {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [id]);
}

async function memberId(companyId: string, userId: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `select id from public.company_members where company_id = $1 and user_id = $2`,
    [companyId, userId],
  );
  return rows.rows[0]!.id;
}

async function raiseMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

let companyId: string;

beforeEach(async () => {
  db = await createTestDb();
  await makeStaff(STAFF, "staff@vendorclr.com");
  await signUp(db, { id: OWNER, email: "owner@acme.test", companyName: "Acme" });
  await signUp(db, { id: OUTSIDER, email: "nobody@acme.test" });
  companyId = await companyIdFor(db, OWNER);
  // A second active owner, so demoting/removing the first is allowed. The user
  // must exist in auth.users first (company_members.user_id FK).
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [
    SECOND,
    "second@acme.test",
  ]);
  await db.query(
    `insert into public.company_members (company_id, user_id, role, last_active_at)
     values ($1, $2, 'owner', now())`,
    [companyId, SECOND],
  );
}, 60_000);

describe("admin_set_company_member_role", () => {
  it("lets staff change a member's role", async () => {
    const id = await memberId(companyId, OWNER);
    await asUser(db, STAFF, `select public.admin_set_company_member_role($1, 'read_only')`, [id]);
    const rows = await db.query<{ role: string }>(
      `select role from public.company_members where id = $1`,
      [id],
    );
    expect(rows.rows[0]?.role).toBe("read_only");
  });

  it("refuses to demote the last active owner", async () => {
    // Remove the second owner first so OWNER is the only one left.
    await db.query(`update public.company_members set deactivated_at = now() where user_id = $1`, [
      SECOND,
    ]);
    const id = await memberId(companyId, OWNER);
    const message = await raiseMessage(() =>
      asUser(db, STAFF, `select public.admin_set_company_member_role($1, 'read_only')`, [id]),
    );
    expect(message).toMatch(/at least one owner/i);
  });

  it("refuses a non-staff caller", async () => {
    const id = await memberId(companyId, OWNER);
    const message = await raiseMessage(() =>
      asUser(db, OUTSIDER, `select public.admin_set_company_member_role($1, 'read_only')`, [id]),
    );
    expect(message).toMatch(/not authorized/i);
  });
});

describe("admin_remove_company_member", () => {
  it("soft-deactivates a member", async () => {
    const id = await memberId(companyId, SECOND);
    await asUser(db, STAFF, `select public.admin_remove_company_member($1)`, [id]);
    const rows = await db.query<{ deactivated_at: string | null }>(
      `select deactivated_at from public.company_members where id = $1`,
      [id],
    );
    expect(rows.rows[0]?.deactivated_at).not.toBeNull();
  });

  it("refuses to remove the last active owner", async () => {
    await db.query(`update public.company_members set deactivated_at = now() where user_id = $1`, [
      SECOND,
    ]);
    const id = await memberId(companyId, OWNER);
    const message = await raiseMessage(() =>
      asUser(db, STAFF, `select public.admin_remove_company_member($1)`, [id]),
    );
    expect(message).toMatch(/at least one owner/i);
  });
});

describe("admin_set_platform_admin", () => {
  it("grants and revokes staff access", async () => {
    await asUser(db, STAFF, `select public.admin_set_platform_admin($1, true)`, [OUTSIDER]);
    let rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.platform_admins where user_id = $1`,
      [OUTSIDER],
    );
    expect(rows.rows[0]?.n).toBe(1);

    await asUser(db, STAFF, `select public.admin_set_platform_admin($1, false)`, [OUTSIDER]);
    rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.platform_admins where user_id = $1`,
      [OUTSIDER],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("refuses to revoke the caller's own access", async () => {
    const message = await raiseMessage(() =>
      asUser(db, STAFF, `select public.admin_set_platform_admin($1, false)`, [STAFF]),
    );
    expect(message).toMatch(/your own super-admin/i);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.platform_admins where user_id = $1`,
      [STAFF],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("refuses a non-staff caller", async () => {
    const message = await raiseMessage(() =>
      asUser(db, OUTSIDER, `select public.admin_set_platform_admin($1, true)`, [OUTSIDER]),
    );
    expect(message).toMatch(/not authorized/i);
  });
});

describe("set_company_plan", () => {
  it("lets staff change a company's plan", async () => {
    await asUser(db, STAFF, `select public.set_company_plan($1, 'enterprise')`, [companyId]);
    const rows = await db.query<{ plan: string }>(
      `select plan from public.companies where id = $1`,
      [companyId],
    );
    expect(rows.rows[0]?.plan).toBe("enterprise");
  });

  it("rejects an unknown plan", async () => {
    const message = await raiseMessage(() =>
      asUser(db, STAFF, `select public.set_company_plan($1, 'Field')`, [companyId]),
    );
    expect(message).toMatch(/unknown plan/i);
  });

  it("refuses a non-staff caller", async () => {
    const message = await raiseMessage(() =>
      asUser(db, OUTSIDER, `select public.set_company_plan($1, 'enterprise')`, [companyId]),
    );
    expect(message).toMatch(/not authorized/i);
  });
});
