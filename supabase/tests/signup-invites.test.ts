import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Behavior of the invite-gated signup path: signup_invites, the redemption
 * logic in handle_new_user(), and the create_signup_invite() RPC that is the
 * only way a row gets into that table. Grant-level checks (who may EXECUTE
 * which function) live in function-grants.test.ts, not here.
 */

const ADMIN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NON_ADMIN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let db: PGlite;

async function insertInvite(
  overrides: Partial<{
    code: string;
    email: string;
    companyName: string;
    status: "pending" | "used" | "revoked";
    expiresAt: string;
  }> = {},
): Promise<string> {
  const email = overrides.email ?? "owner@newco.test";
  const companyName = overrides.companyName ?? "New Co";
  const expiresAt = overrides.expiresAt ?? "now() + interval '14 days'";
  const status = overrides.status ?? "pending";

  const result = await db.query<{ code: string }>(
    `insert into public.signup_invites (code, email, company_name, status, expires_at)
     values (coalesce($1, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))), $2, $3, $4, ${expiresAt})
     returning code`,
    [overrides.code ?? null, email, companyName, status],
  );
  return result.rows[0]!.code;
}

beforeEach(async () => {
  db = await createTestDb();

  await signUp(db, { id: ADMIN, email: "admin@vendorclear.test" });
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [ADMIN]);
  await signUp(db, { id: NON_ADMIN, email: "member@rival.test" });
}, 60_000);

describe("handle_new_user redeems a valid invite", () => {
  it("creates the company from the invite's company_name, not any client input", async () => {
    const code = await insertInvite({ email: "owner@newco.test", companyName: "New Co" });
    const userId = "10000000-0000-0000-0000-000000000001";

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [userId, "owner@newco.test", JSON.stringify({ invite_code: code })],
    );

    const companyId = await companyIdFor(db, userId);
    const company = await db.query<{ name: string }>(
      `select name from public.companies where id = $1`,
      [companyId],
    );
    expect(company.rows[0]?.name).toBe("New Co");

    const membership = await db.query<{ role: string }>(
      `select role from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, userId],
    );
    expect(membership.rows[0]?.role).toBe("owner");

    const invite = await db.query<{ status: string; used_by: string }>(
      `select status, used_by from public.signup_invites where code = $1`,
      [code],
    );
    expect(invite.rows[0]?.status).toBe("used");
    expect(invite.rows[0]?.used_by).toBe(userId);
  });

  it("matches the code case-insensitively", async () => {
    const code = await insertInvite({ email: "owner@lower.test", companyName: "Lower Co" });
    const userId = "10000000-0000-0000-0000-000000000002";

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [userId, "owner@lower.test", JSON.stringify({ invite_code: code.toLowerCase() })],
    );

    await expect(companyIdFor(db, userId)).resolves.toBeTruthy();
  });
});

describe("handle_new_user rejects an invalid invite, aborting the whole signup", () => {
  async function attemptSignup(userId: string, email: string, code: string): Promise<Error> {
    try {
      await db.query(
        `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
        [userId, email, JSON.stringify({ invite_code: code })],
      );
      throw new Error("expected signup to be rejected, but it succeeded");
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async function expectNoTraceOfUser(userId: string): Promise<void> {
    const users = await db.query(`select 1 from auth.users where id = $1`, [userId]);
    expect(users.rows).toHaveLength(0);
    const profiles = await db.query(`select 1 from public.profiles where id = $1`, [userId]);
    expect(profiles.rows).toHaveLength(0);
  }

  it("rejects a code that does not exist", async () => {
    const userId = "20000000-0000-0000-0000-000000000001";
    const error = await attemptSignup(userId, "nobody@newco.test", "NOSUCHCODE");
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  it("rejects an expired code", async () => {
    const code = await insertInvite({
      email: "late@newco.test",
      expiresAt: "now() - interval '1 day'",
    });
    const userId = "20000000-0000-0000-0000-000000000002";
    const error = await attemptSignup(userId, "late@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  it("rejects a code redeemed with the wrong email", async () => {
    const code = await insertInvite({ email: "intended@newco.test" });
    const userId = "20000000-0000-0000-0000-000000000003";
    const error = await attemptSignup(userId, "someone-else@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  it("rejects a revoked code", async () => {
    const code = await insertInvite({ email: "revoked@newco.test", status: "revoked" });
    const userId = "20000000-0000-0000-0000-000000000004";
    const error = await attemptSignup(userId, "revoked@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  // Only the sequential case is exercised here: first redemption commits,
  // then a second attempt sees status = 'used'. The `for update` lock in
  // handle_new_user() also exists to fail closed under two *concurrent*
  // redemptions racing for the same still-pending code - that guarantee
  // rests on documented Postgres row-locking semantics, verified by manual
  // review rather than an automated test in this file, because PGlite is a
  // single in-memory instance and does not give us two genuinely
  // overlapping in-flight transactions to race against each other. Same
  // category of gap as the pg_net/pg_cron skip list and the GoTrue-stub
  // caveat noted at the top of harness.ts.
  it("rejects a code that has already been used", async () => {
    const code = await insertInvite({ email: "reused@newco.test" });
    const firstUser = "20000000-0000-0000-0000-000000000005";
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [firstUser, "reused@newco.test", JSON.stringify({ invite_code: code })],
    );

    const secondUser = "20000000-0000-0000-0000-000000000006";
    const error = await attemptSignup(secondUser, "reused@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(secondUser);
  });

  it("still creates a profile with no company when no code is sent at all", async () => {
    const userId = "20000000-0000-0000-0000-000000000007";
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}'::jsonb)`,
      [userId, "no-code@example.test"],
    );

    const profile = await db.query(`select 1 from public.profiles where id = $1`, [userId]);
    expect(profile.rows).toHaveLength(1);
    const membership = await db.query(`select 1 from public.company_members where user_id = $1`, [
      userId,
    ]);
    expect(membership.rows).toHaveLength(0);
  });
});

describe("create_signup_invite()", () => {
  it("lets a platform admin create a pending invite with a generated code and ~14-day expiry", async () => {
    const rows = await asUser<{
      code: string;
      status: string;
      expires_at: string;
      created_at: string;
    }>(
      db,
      ADMIN,
      `select code, status, expires_at, created_at from public.create_signup_invite($1, $2)`,
      ["Fresh Co", "owner@freshco.test"],
    );

    const invite = rows[0]!;
    expect(invite.status).toBe("pending");
    expect(invite.code).toMatch(/^[0-9A-F]{10}$/);

    const daysUntilExpiry =
      (new Date(invite.expires_at).getTime() - new Date(invite.created_at).getTime()) /
      (1000 * 60 * 60 * 24);
    expect(daysUntilExpiry).toBeGreaterThan(13);
    expect(daysUntilExpiry).toBeLessThan(15);
  });

  it("denies a non-admin", async () => {
    await expect(
      asUser(db, NON_ADMIN, `select public.create_signup_invite($1, $2)`, [
        "Rival Co",
        "x@rival.test",
      ]),
    ).rejects.toThrow(/not authorized/i);
  });
});

describe("signup_invites RLS", () => {
  it("lets a platform admin select and update invites", async () => {
    const code = await insertInvite({ email: "visible@newco.test" });

    const rows = await asUser<{ code: string }>(
      db,
      ADMIN,
      `select code from public.signup_invites where code = $1`,
      [code],
    );
    expect(rows).toHaveLength(1);

    await asUser(db, ADMIN, `update public.signup_invites set status = 'revoked' where code = $1`, [
      code,
    ]);
    const after = await db.query<{ status: string }>(
      `select status from public.signup_invites where code = $1`,
      [code],
    );
    expect(after.rows[0]?.status).toBe("revoked");
  });

  it("hides invites from a non-admin", async () => {
    await insertInvite({ email: "hidden@newco.test" });

    const rows = await asUser<{ code: string }>(
      db,
      NON_ADMIN,
      `select code from public.signup_invites`,
    );
    expect(rows).toHaveLength(0);
  });

  it("denies a non-admin's update", async () => {
    const code = await insertInvite({ email: "protected@newco.test" });

    // Not expectDeniedByRls(): the update policy's USING clause is just
    // is_platform_admin(), with no other visibility path, so a non-admin's
    // UPDATE simply matches zero rows and succeeds without error - same
    // shape as audit-log.test.ts and upload-requests.test.ts. The real
    // assertion is that the row is provably unchanged afterward.
    await asUser(
      db,
      NON_ADMIN,
      `update public.signup_invites set status = 'revoked' where code = $1`,
      [code],
    );
    const after = await db.query<{ status: string }>(
      `select status from public.signup_invites where code = $1`,
      [code],
    );
    expect(after.rows[0]?.status).toBe("pending");
  });
});
