import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, createTestDb, signUp } from "./harness";

/**
 * signup_invites survives the activation-code access model change
 * (20260918000200_activation_codes.sql) unchanged as a table and an RPC -
 * create_signup_invite() and its RLS are exactly as before. What changed is
 * handle_new_user(): it used to redeem an invite_code from signup metadata
 * into a company, and now never does. That retirement is the first describe
 * block below; create_signup_invite()/RLS below it are unchanged coverage.
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

describe("handle_new_user is profile-only under the activation-code access model", () => {
  it("creates no company even when a valid invite_code is sent in signup metadata", async () => {
    const code = await insertInvite({ email: "owner@newco.test", companyName: "New Co" });
    const userId = "10000000-0000-0000-0000-000000000001";

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [userId, "owner@newco.test", JSON.stringify({ invite_code: code })],
    );

    const profile = await db.query(`select 1 from public.profiles where id = $1`, [userId]);
    expect(profile.rows).toHaveLength(1);
    const membership = await db.query(`select 1 from public.company_members where user_id = $1`, [
      userId,
    ]);
    expect(membership.rows).toHaveLength(0);

    // The gate that used to consume this row on signup is gone; nothing in
    // handle_new_user() touches signup_invites any more, so it is untouched.
    const invite = await db.query<{ status: string }>(
      `select status from public.signup_invites where code = $1`,
      [code],
    );
    expect(invite.rows[0]?.status).toBe("pending");
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
