import type { PGlite } from "@electric-sql/pglite";
import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * company_invitations, the last-active-owner guard on company_members, and
 * the SECURITY DEFINER RPCs that are the only way any of it is ever written
 * (migration 20260916000500_company_member_invitations.sql). node:crypto is
 * fine here - this is a Node test file, not app code shipping to Cloudflare
 * Workers (see uploadTokens.ts's own docblock for why the app code itself
 * avoids it).
 */

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function freshTokenHash(): string {
  return hashToken(randomBytes(32).toString("hex"));
}

const FUTURE = "now() + interval '7 days'";

const OWNER = "11111111-1111-1111-1111-111111111111";
const SECOND_OWNER = "11111111-1111-1111-1111-111111111112";
const RISK_MANAGER = "22222222-2222-2222-2222-222222222222";
const PROJECT_ENGINEER = "33333333-3333-3333-3333-333333333333";
const READ_ONLY = "44444444-4444-4444-4444-444444444444";
const RIVAL_OWNER = "55555555-5555-5555-5555-555555555555";
const INVITEE = "66666666-6666-6666-6666-666666666666";

let db: PGlite;
let companyId: string;

async function addMember(userId: string, role: string): Promise<void> {
  await db.query(
    `insert into public.company_members (company_id, user_id, role, last_active_at) values ($1, $2, $3, now())`,
    [companyId, userId, role],
  );
}

async function createInvitation(
  overrides: {
    email?: string;
    role?: string;
    expiresSql?: string;
  } = {},
): Promise<{ id: string; token_hash: string }> {
  const tokenHash = freshTokenHash();
  const rows = await asUser<{ id: string; token_hash: string }>(
    db,
    OWNER,
    `select id, token_hash from public.create_company_invitation($1, $2, $3, $4, ${overrides.expiresSql ?? FUTURE})`,
    [
      companyId,
      overrides.email ?? "invitee@halstead.test",
      overrides.role ?? "risk_manager",
      tokenHash,
    ],
  );
  return rows[0]!;
}

beforeEach(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);

  await signUp(db, { id: SECOND_OWNER, email: "owner2@halstead.test" });
  await addMember(SECOND_OWNER, "owner");
  await signUp(db, { id: RISK_MANAGER, email: "risk@halstead.test" });
  await addMember(RISK_MANAGER, "risk_manager");
  await signUp(db, { id: PROJECT_ENGINEER, email: "engineer@halstead.test" });
  await addMember(PROJECT_ENGINEER, "project_engineer");
  await signUp(db, { id: READ_ONLY, email: "reader@halstead.test" });
  await addMember(READ_ONLY, "read_only");

  await signUp(db, { id: RIVAL_OWNER, email: "owner@rival.test", companyName: "Rival Co" });
  await signUp(db, { id: INVITEE, email: "invitee@halstead.test" });
}, 60_000);

describe("create_company_invitation()", () => {
  it("lets an owner create a pending invitation with a normalized email", async () => {
    const tokenHash = freshTokenHash();
    const rows = await asUser<{
      email: string;
      status: string;
      role: string;
      resend_count: number;
    }>(
      db,
      OWNER,
      `select email, status, role, resend_count from public.create_company_invitation($1, $2, $3, $4, ${FUTURE})`,
      [companyId, "  Invitee@Halstead.TEST  ", "risk_manager", tokenHash],
    );
    expect(rows[0]).toEqual({
      email: "invitee@halstead.test",
      status: "pending",
      role: "risk_manager",
      resend_count: 0,
    });
  });

  it.each(["risk_manager", "project_engineer", "read_only"])(
    "denies a %s member - only owners may invite",
    async (nonOwner) => {
      const userByRole: Record<string, string> = {
        risk_manager: RISK_MANAGER,
        project_engineer: PROJECT_ENGINEER,
        read_only: READ_ONLY,
      };
      await expect(
        asUser(
          db,
          userByRole[nonOwner]!,
          `select public.create_company_invitation($1, $2, $3, $4, ${FUTURE})`,
          [companyId, "someone@halstead.test", "read_only", freshTokenHash()],
        ),
      ).rejects.toThrow(/not authorized/i);
    },
  );

  it("writes a member_invited audit row atomically with the insert", async () => {
    const invite = await createInvitation();
    const rows = await db.query<{ action: string; target_type: string; target_id: string }>(
      `select action, target_type, target_id from public.audit_log
       where company_id = $1 and action = 'member_invited'`,
      [companyId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({
      action: "member_invited",
      target_type: "company_invitation",
      target_id: invite.id,
    });
  });

  it("supersedes an existing pending invite to the same email", async () => {
    const first = await createInvitation({ email: "dup@halstead.test" });
    await createInvitation({ email: "dup@halstead.test" });

    const firstAfter = await db.query<{ status: string }>(
      `select status from public.company_invitations where id = $1`,
      [first.id],
    );
    expect(firstAfter.rows[0]?.status).toBe("revoked");

    const pendingCount = await db.query<{ n: number }>(
      `select count(*)::int n from public.company_invitations
       where company_id = $1 and email = 'dup@halstead.test' and status = 'pending'`,
      [companyId],
    );
    expect(pendingCount.rows[0]?.n).toBe(1);
  });

  it("rejects inviting someone who is already an active member", async () => {
    await expect(
      asUser(db, OWNER, `select public.create_company_invitation($1, $2, $3, $4, ${FUTURE})`, [
        companyId,
        "risk@halstead.test",
        "risk_manager",
        freshTokenHash(),
      ]),
    ).rejects.toThrow(/already an active member/i);
  });
});

describe("company_invitations RLS (select)", () => {
  beforeEach(async () => {
    await createInvitation();
  });

  it("is visible to an owner", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      OWNER,
      `select count(*)::int n from public.company_invitations where company_id = $1`,
      [companyId],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it.each([
    ["risk_manager", RISK_MANAGER],
    ["project_engineer", PROJECT_ENGINEER],
    ["read_only", READ_ONLY],
  ])("is hidden from a %s member - invitations are owner-only", async (_role, userId) => {
    const rows = await asUser<{ n: number }>(
      db,
      userId,
      `select count(*)::int n from public.company_invitations where company_id = $1`,
      [companyId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("is hidden from a different company's owner", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.company_invitations where company_id = $1`,
      [companyId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("resend_company_invitation()", () => {
  it("revokes the old token and issues a new one, bumping resend_count", async () => {
    const invite = await createInvitation();
    const newTokenHash = freshTokenHash();

    const rows = await asUser<{ token_hash: string; resend_count: number; status: string }>(
      db,
      OWNER,
      `select token_hash, resend_count, status from public.resend_company_invitation($1, $2, ${FUTURE})`,
      [invite.id, newTokenHash],
    );
    expect(rows[0]?.token_hash).toBe(newTokenHash);
    expect(rows[0]?.resend_count).toBe(1);
    expect(rows[0]?.status).toBe("pending");

    // The old token no longer resolves to this invitation at all.
    const oldTokenLookup = await db.query(
      `select 1 from public.company_invitations where token_hash = $1`,
      [invite.token_hash],
    );
    expect(oldTokenLookup.rows).toHaveLength(0);
  });

  it("denies a non-owner", async () => {
    const invite = await createInvitation();
    await expect(
      asUser(db, RISK_MANAGER, `select public.resend_company_invitation($1, $2, ${FUTURE})`, [
        invite.id,
        freshTokenHash(),
      ]),
    ).rejects.toThrow(/not authorized/i);
  });

  it("rejects resending an already-accepted invitation", async () => {
    const invite = await createInvitation({ email: "invitee@halstead.test" });
    await asUser(db, INVITEE, `select public.accept_company_invitation($1)`, [invite.token_hash]);

    await expect(
      asUser(db, OWNER, `select public.resend_company_invitation($1, $2, ${FUTURE})`, [
        invite.id,
        freshTokenHash(),
      ]),
    ).rejects.toThrow(/already/i);
  });
});

describe("revoke_company_invitation()", () => {
  it("marks the invitation revoked and writes an audit row", async () => {
    const invite = await createInvitation();
    await asUser(db, OWNER, `select public.revoke_company_invitation($1)`, [invite.id]);

    const after = await db.query<{ status: string }>(
      `select status from public.company_invitations where id = $1`,
      [invite.id],
    );
    expect(after.rows[0]?.status).toBe("revoked");

    const audit = await db.query(
      `select 1 from public.audit_log where target_id = $1 and action = 'member_invite_revoked'`,
      [invite.id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("denies a non-owner", async () => {
    const invite = await createInvitation();
    await expect(
      asUser(db, PROJECT_ENGINEER, `select public.revoke_company_invitation($1)`, [invite.id]),
    ).rejects.toThrow(/not authorized/i);
  });
});

describe("accept_company_invitation() - email must match", () => {
  it("accepts when the authenticated caller's email matches the invitation", async () => {
    const invite = await createInvitation({ email: "invitee@halstead.test" });
    const rows = await asUser<{ accept_company_invitation: { companyId: string; role: string } }>(
      db,
      INVITEE,
      `select public.accept_company_invitation($1)`,
      [invite.token_hash],
    );
    expect(rows[0]?.accept_company_invitation).toEqual({ companyId, role: "risk_manager" });

    const membership = await db.query<{ role: string }>(
      `select role from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, INVITEE],
    );
    expect(membership.rows[0]?.role).toBe("risk_manager");

    const invitationAfter = await db.query<{ status: string; accepted_by: string }>(
      `select status, accepted_by from public.company_invitations where id = $1`,
      [invite.id],
    );
    expect(invitationAfter.rows[0]?.status).toBe("accepted");
    expect(invitationAfter.rows[0]?.accepted_by).toBe(INVITEE);

    const audit = await db.query(
      `select 1 from public.audit_log where target_id = $1 and action = 'invite_accepted'`,
      [invite.id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("rejects a different authenticated user - email mismatch cannot join the company", async () => {
    const invite = await createInvitation({ email: "invitee@halstead.test" });

    await expect(
      asUser(db, RIVAL_OWNER, `select public.accept_company_invitation($1)`, [invite.token_hash]),
    ).rejects.toThrow(/different email/i);

    const membership = await db.query(
      `select 1 from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, RIVAL_OWNER],
    );
    expect(membership.rows).toHaveLength(0);
  });

  it("rejects an unknown token", async () => {
    await expect(
      asUser(db, INVITEE, `select public.accept_company_invitation($1)`, ["not-a-real-hash"]),
    ).rejects.toThrow(/no longer valid/i);
  });

  it("rejects an invitation past its expiry, even though status is still stored as 'pending'", async () => {
    // accept_company_invitation() deliberately does not persist status =
    // 'expired' here - see the migration's docblock at this check for why
    // (a single failing statement cannot partially commit). Display-time
    // expiry (displayStatus() in companyInvitations.ts) covers showing this
    // correctly in a list; this test only needs to prove the stale stored
    // 'pending' value does not let an expired link actually be redeemed.
    const invite = await createInvitation({
      email: "invitee@halstead.test",
      expiresSql: "now() - interval '1 hour'",
    });

    await expect(
      asUser(db, INVITEE, `select public.accept_company_invitation($1)`, [invite.token_hash]),
    ).rejects.toThrow(/no longer valid/i);

    const after = await db.query<{ status: string }>(
      `select status from public.company_invitations where id = $1`,
      [invite.id],
    );
    expect(after.rows[0]?.status).toBe("pending");

    const membership = await db.query(
      `select 1 from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, INVITEE],
    );
    expect(membership.rows).toHaveLength(0);
  });

  it("rejects a revoked invitation", async () => {
    const invite = await createInvitation({ email: "invitee@halstead.test" });
    await asUser(db, OWNER, `select public.revoke_company_invitation($1)`, [invite.id]);

    await expect(
      asUser(db, INVITEE, `select public.accept_company_invitation($1)`, [invite.token_hash]),
    ).rejects.toThrow(/no longer valid/i);
  });
});

describe("last-active-owner guard", () => {
  it("blocks demoting the sole active owner", async () => {
    // OWNER is the sole owner in this sub-scenario: demote SECOND_OWNER first.
    await db.query(
      `update public.company_members set role = 'risk_manager' where company_id = $1 and user_id = $2`,
      [companyId, SECOND_OWNER],
    );

    const ownerMemberId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, OWNER],
    );

    await expect(
      asUser(db, OWNER, `select public.change_company_member_role($1, 'risk_manager')`, [
        ownerMemberId.rows[0]!.id,
      ]),
    ).rejects.toThrow(/last active owner/i);

    const after = await db.query<{ role: string }>(
      `select role from public.company_members where id = $1`,
      [ownerMemberId.rows[0]!.id],
    );
    expect(after.rows[0]?.role).toBe("owner");

    // No audit row for a blocked change.
    const audit = await db.query(
      `select 1 from public.audit_log where company_id = $1 and action = 'member_role_changed'`,
      [companyId],
    );
    expect(audit.rows).toHaveLength(0);
  });

  it("blocks removing the sole active owner", async () => {
    await db.query(
      `update public.company_members set role = 'risk_manager' where company_id = $1 and user_id = $2`,
      [companyId, SECOND_OWNER],
    );
    const ownerMemberId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, OWNER],
    );

    await expect(
      asUser(db, OWNER, `select public.remove_company_member($1)`, [ownerMemberId.rows[0]!.id]),
    ).rejects.toThrow(/last active owner/i);
  });

  it("allows demoting an owner when another active owner remains", async () => {
    const secondOwnerMemberId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, SECOND_OWNER],
    );

    await asUser(db, OWNER, `select public.change_company_member_role($1, 'risk_manager')`, [
      secondOwnerMemberId.rows[0]!.id,
    ]);

    const after = await db.query<{ role: string }>(
      `select role from public.company_members where id = $1`,
      [secondOwnerMemberId.rows[0]!.id],
    );
    expect(after.rows[0]?.role).toBe("risk_manager");
  });

  it("deactivates a member and writes a member_removed audit row, and the member loses company access", async () => {
    const secondOwnerMemberId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, SECOND_OWNER],
    );

    await asUser(db, OWNER, `select public.remove_company_member($1)`, [
      secondOwnerMemberId.rows[0]!.id,
    ]);

    const after = await db.query<{ deactivated_at: string | null }>(
      `select deactivated_at from public.company_members where id = $1`,
      [secondOwnerMemberId.rows[0]!.id],
    );
    expect(after.rows[0]?.deactivated_at).not.toBeNull();

    const audit = await db.query(
      `select 1 from public.audit_log where target_id = $1 and action = 'member_removed'`,
      [secondOwnerMemberId.rows[0]!.id],
    );
    expect(audit.rows).toHaveLength(1);

    // A deactivated member's company_id no longer shows up in current_company_ids() for them.
    const visibleCompanies = await asUser<{ n: number }>(
      db,
      SECOND_OWNER,
      `select count(*)::int n from public.companies where id = $1`,
      [companyId],
    );
    expect(visibleCompanies[0]?.n).toBe(0);
  });

  /**
   * The deliberate judgment call this task's brief asked to make explicitly:
   * a single atomic UPDATE that promotes a new owner and demotes the sole
   * existing owner in the SAME statement must succeed, even though demoting
   * that owner ALONE (as its own separate statement, with no promotion)
   * would correctly be blocked by the test above. transfer_company_ownership()
   * issues exactly one UPDATE covering both rows so the statement-level
   * trigger only ever evaluates the net post-statement state.
   */
  it("allows an atomic ownership transfer even when the outgoing owner is the sole owner", async () => {
    await db.query(
      `update public.company_members set role = 'risk_manager' where company_id = $1 and user_id = $2`,
      [companyId, SECOND_OWNER],
    );

    const ownerMemberId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, OWNER],
    );
    const newOwnerMemberId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, SECOND_OWNER],
    );

    await asUser(db, OWNER, `select public.transfer_company_ownership($1, $2, 'risk_manager')`, [
      ownerMemberId.rows[0]!.id,
      newOwnerMemberId.rows[0]!.id,
    ]);

    const roles = await db.query<{ user_id: string; role: string }>(
      `select user_id, role from public.company_members where company_id = $1 and user_id in ($2, $3)`,
      [companyId, OWNER, SECOND_OWNER],
    );
    const byUser = new Map(roles.rows.map((r) => [r.user_id, r.role]));
    expect(byUser.get(OWNER)).toBe("risk_manager");
    expect(byUser.get(SECOND_OWNER)).toBe("owner");

    const auditRows = await db.query<{ action: string }>(
      `select action from public.audit_log where company_id = $1 and action = 'member_role_changed'`,
      [companyId],
    );
    expect(auditRows.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("change_company_member_role() / remove_company_member() authorization", () => {
  it.each([
    ["risk_manager", RISK_MANAGER],
    ["project_engineer", PROJECT_ENGINEER],
    ["read_only", READ_ONLY],
  ])("denies a %s member from changing another member's role", async (_role, userId) => {
    const targetId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, READ_ONLY],
    );
    await expect(
      asUser(db, userId, `select public.change_company_member_role($1, 'project_engineer')`, [
        targetId.rows[0]!.id,
      ]),
    ).rejects.toThrow(/not authorized/i);
  });

  it("denies a non-owner from removing a member", async () => {
    const targetId = await db.query<{ id: string }>(
      `select id from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, READ_ONLY],
    );
    await expect(
      asUser(db, PROJECT_ENGINEER, `select public.remove_company_member($1)`, [
        targetId.rows[0]!.id,
      ]),
    ).rejects.toThrow(/not authorized/i);
  });
});
