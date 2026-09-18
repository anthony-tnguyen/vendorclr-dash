import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Loaded lazily inside handlers, matching the established pattern in
 * vendorUploadRequests.ts: a static import of a *.server module puts it in
 * the client import graph (this file is imported by React components), which
 * this project's import protection rejects.
 */
async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}
async function getServiceRoleClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getServiceRoleClient();
}

import { getEmailSender } from "./emailSender";
import {
  companyInvitationHtml,
  companyInvitationSubject,
  companyInvitationText,
} from "./emailTemplates";
import { generateUploadToken, hashToken } from "./uploadTokens";

/**
 * Task 6 - company teammate invitations and the access lifecycle
 * (invite/resend/revoke, accept, and existing-member role change/removal).
 *
 * Distinct from the activation codes that open a brand-new company
 * (activation_codes + create_activation_code()): those are a sales-side
 * surface and are untouched by this file. Everything here is about inviting a
 * teammate to, or managing membership within, a company that already exists.
 *
 * This is the actual interface contract for the future UI task
 * (CompanyAccessPage.tsx, the accept-invite.$token.tsx route, and a rewrite
 * of AccessPage.tsx - none of which this task builds). Every exported
 * function's docblock says what it returns and why, since that UI will be
 * built by someone with no memory of this session.
 *
 * Every mutating SQL RPC this file calls (create_company_invitation,
 * resend_company_invitation, revoke_company_invitation,
 * accept_company_invitation, change_company_member_role,
 * remove_company_member, transfer_company_ownership - all in migration
 * 20260916000500_company_member_invitations.sql) is SECURITY DEFINER and
 * does its own explicit authorization check as its first real statement -
 * RLS does not apply inside a SECURITY DEFINER function body (it runs as
 * the function owner, postgres, which has rolbypassrls = true), a lesson
 * from a real cross-tenant leak in Task 4. Every one of those RPCs also
 * writes its audit_log row in the same function call as the mutation
 * itself, so the two can never drift apart the way two independent
 * request-scoped statements could.
 */

export type CompanyMemberRole = "owner" | "risk_manager" | "project_engineer" | "read_only";

/** How long an invitation link is valid before accept_company_invitation() marks it 'expired'. */
export const INVITATION_TTL_DAYS = 7;

function newInvitationExpiry(from: Date = new Date()): Date {
  const expires = new Date(from);
  expires.setUTCDate(expires.getUTCDate() + INVITATION_TTL_DAYS);
  return expires;
}

function bareAppUrl(): string {
  const configured = import.meta.env["VITE_APP_URL"]?.trim();
  return (configured || "http://localhost:3000").replace(/\/+$/, "");
}

function acceptInvitationUrl(token: string): string {
  return `${bareAppUrl()}/accept-invite/${token}`;
}

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

/**
 * One invitation as a future UI needs to render it: pending, accepted,
 * revoked, or - computed here, not stored, see below - expired.
 *
 * `status` is the DB column's value EXCEPT that a 'pending' row whose
 * `expiresAt` has already passed is reported here as 'expired' even though
 * accept_company_invitation() has not yet lazily flipped the stored column
 * (that only happens the moment someone actually tries the link). A list
 * screen must not show a dead link as "pending" just because nobody has
 * clicked it yet.
 *
 * `bounced` is deliberately NOT a value of this union - see this file's
 * top-level docblock reference in the Task 6 plan: an invitation can be
 * 'pending' while its underlying email bounced. That is tracked by the
 * existing Phase 4 email_outbox/email_delivery_events tables, keyed by
 * `to_email` + `template = 'company_invitation'` (this file's
 * inviteCompanyMember()/resendCompanyInvitation() both insert an
 * email_outbox row exactly like createUploadRequest() does) - a future UI
 * wanting to show "bounced" should join against those tables by email
 * rather than this function growing a redundant status. This function does
 * not do that join itself since nothing here needs it yet; flagging it so
 * whoever builds the UI does not have to rediscover it.
 */
export interface CompanyInvitation {
  id: string;
  companyId: string;
  email: string;
  role: CompanyMemberRole;
  status: "pending" | "accepted" | "expired" | "revoked";
  invitedByEmail: string | null;
  resendCount: number;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/** One company_members row as a future UI needs it, including a deactivated (removed) member so the access screen can show "removed" rather than just omitting them. */
export interface CompanyMemberSummary {
  id: string;
  userId: string;
  email: string | null;
  role: CompanyMemberRole;
  isActive: boolean;
  lastActiveAt: string | null;
  createdAt: string;
}

interface CompanyInvitationRow {
  id: string;
  company_id: string;
  email: string;
  role: CompanyMemberRole;
  status: "pending" | "accepted" | "expired" | "revoked";
  invited_by: string | null;
  resend_count: number;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

function displayStatus(row: CompanyInvitationRow): CompanyInvitation["status"] {
  if (row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now()) {
    return "expired";
  }
  return row.status;
}

/** Every distinct non-null value of `invited_by` across a batch of invitation rows, resolved to email via profiles - two queries, not a PostgREST embed: company_invitations.invited_by and profiles.id both independently reference auth.users, with no direct FK between the two tables for PostgREST to embed through (the same shape documented at fetchOwnerEmails() in vendorUploadRequests.ts). */
async function resolveInviterEmails(
  supabase: Awaited<ReturnType<typeof getRequestScopedClient>>,
  inviterIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(inviterIds)];
  if (unique.length === 0) return new Map();
  const { data } = await supabase.from("profiles").select("id, email").in("id", unique);
  return new Map(
    ((data ?? []) as Array<{ id: string; email: string }>).map((p) => [p.id, p.email]),
  );
}

function toCompanyInvitation(
  row: CompanyInvitationRow,
  inviterEmails: Map<string, string>,
): CompanyInvitation {
  return {
    id: row.id,
    companyId: row.company_id,
    email: row.email,
    role: row.role,
    status: displayStatus(row),
    invitedByEmail: row.invited_by ? (inviterEmails.get(row.invited_by) ?? null) : null,
    resendCount: row.resend_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

// ---------------------------------------------------------------------------
// inviteCompanyMember - authenticated, runs via RLS as the calling owner
// ---------------------------------------------------------------------------

const inviteCompanyMemberSchema = z.object({
  companyId: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["owner", "risk_manager", "project_engineer", "read_only"]),
});

export interface InviteCompanyMemberResult {
  invitation: CompanyInvitation;
  acceptUrl: string;
  email: { status: "sent" | "failed" | "not_configured"; to: string };
}

/**
 * Invites a teammate to an existing company. Only an owner of `companyId`
 * may call this - enforced twice: create_company_invitation() (the RPC this
 * calls) raises 'not authorized' (42501) as its first check, and this
 * function's own request-scoped client means the RPC runs as the calling
 * user, so it cannot be spoofed into acting as someone else.
 *
 * Generates the plaintext token and its SHA-256 hash here (Web Crypto only,
 * same as uploadTokens.ts - this deploys to Cloudflare Workers, so no
 * node:crypto/Buffer) and sends only the hash to the database; the plaintext
 * exists only long enough to build the email/acceptUrl.
 *
 * Matches createUploadRequest()'s graceful-degradation shape exactly: if
 * RESEND_API_KEY is unset, the invitation is still created and `acceptUrl`
 * is still returned to the calling owner, who can copy/paste it manually.
 */
export const inviteCompanyMember = createServerFn({ method: "POST" })
  .validator(inviteCompanyMemberSchema)
  .handler(async ({ data }): Promise<InviteCompanyMemberResult> => {
    const supabase = await getRequestScopedClient();

    const token = generateUploadToken();
    const tokenHash = await hashToken(token);
    const expiresAt = newInvitationExpiry();

    const { data: row, error } = await supabase.rpc("create_company_invitation", {
      target_company: data.companyId,
      invitee_email: data.email,
      invitee_role: data.role,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt.toISOString(),
    });

    if (error || !row) throw new Error(error?.message ?? "Could not create the invitation.");

    const invitationRow = row as unknown as CompanyInvitationRow;
    const acceptUrl = acceptInvitationUrl(token);

    const { data: authUser } = await supabase.auth.getUser();
    const inviterEmail = authUser.user?.email ?? "A teammate";

    const { data: company } = await supabase
      .from("companies")
      .select("name")
      .eq("id", data.companyId)
      .maybeSingle();

    const sendResult = await getEmailSender().send({
      to: invitationRow.email,
      subject: companyInvitationSubject({
        companyName: company?.name ?? "your company",
        inviterEmail,
        role: data.role,
        acceptUrl,
      }),
      html: companyInvitationHtml({
        companyName: company?.name ?? "your company",
        inviterEmail,
        role: data.role,
        acceptUrl,
      }),
      text: companyInvitationText({
        companyName: company?.name ?? "your company",
        inviterEmail,
        role: data.role,
        acceptUrl,
      }),
    });

    await supabase.from("email_outbox").insert({
      company_id: data.companyId,
      template: "company_invitation",
      to_email: invitationRow.email,
      status:
        sendResult.status === "sent"
          ? "sent"
          : sendResult.status === "failed"
            ? "failed"
            : "queued",
      provider_message_id: sendResult.providerMessageId,
      error: sendResult.error,
      sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
    });

    return {
      invitation: toCompanyInvitation(
        invitationRow,
        new Map([[invitationRow.invited_by ?? "", inviterEmail]]),
      ),
      acceptUrl,
      email: { status: sendResult.status, to: invitationRow.email },
    };
  });

// ---------------------------------------------------------------------------
// listCompanyInvitations - authenticated, RLS as the calling owner
// ---------------------------------------------------------------------------

const listCompanyInvitationsSchema = z.object({ companyId: z.string().uuid() });

/**
 * Every invitation for `companyId`, newest first. RLS
 * (company_invitations_select) restricts this to an owner of the company or
 * platform staff - a non-owner's call simply returns an empty list, the same
 * "RLS silently scopes the result rather than throwing" shape as
 * listUploadRequestsForVendor().
 */
export const listCompanyInvitations = createServerFn({ method: "GET" })
  .validator(listCompanyInvitationsSchema)
  .handler(async ({ data }): Promise<CompanyInvitation[]> => {
    const supabase = await getRequestScopedClient();
    const { data: rows, error } = await supabase
      .from("company_invitations")
      .select(
        "id, company_id, email, role, status, invited_by, resend_count, created_at, expires_at, accepted_at, revoked_at",
      )
      .eq("company_id", data.companyId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    const invitationRows = (rows ?? []) as CompanyInvitationRow[];
    const inviterEmails = await resolveInviterEmails(
      supabase,
      invitationRows.map((r) => r.invited_by).filter((id): id is string => Boolean(id)),
    );

    return invitationRows.map((row) => toCompanyInvitation(row, inviterEmails));
  });

// ---------------------------------------------------------------------------
// resendCompanyInvitation - authenticated, RLS as the calling owner
// ---------------------------------------------------------------------------

const resendCompanyInvitationSchema = z.object({ invitationId: z.string().uuid() });

export interface ResendCompanyInvitationResult {
  invitation: CompanyInvitation;
  acceptUrl: string;
  email: { status: "sent" | "failed" | "not_configured"; to: string };
}

/**
 * Revokes the invitation's old token and issues a fresh one with a new
 * 7-day expiry (resend_company_invitation() does both in one statement, so
 * the old token stops working the instant a new one is issued - there is
 * never a window where both are simultaneously valid). Only callable by an
 * owner of the invitation's company; only valid from 'pending' or 'expired'
 * - an already-accepted or already-revoked invitation cannot be resent
 * (resend_company_invitation() raises otherwise).
 */
export const resendCompanyInvitation = createServerFn({ method: "POST" })
  .validator(resendCompanyInvitationSchema)
  .handler(async ({ data }): Promise<ResendCompanyInvitationResult> => {
    const supabase = await getRequestScopedClient();

    const token = generateUploadToken();
    const tokenHash = await hashToken(token);
    const expiresAt = newInvitationExpiry();

    const { data: row, error } = await supabase.rpc("resend_company_invitation", {
      invitation_id: data.invitationId,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt.toISOString(),
    });

    if (error || !row) throw new Error(error?.message ?? "Could not resend the invitation.");

    const invitationRow = row as unknown as CompanyInvitationRow;
    const acceptUrl = acceptInvitationUrl(token);

    const { data: authUser } = await supabase.auth.getUser();
    const inviterEmail = authUser.user?.email ?? "A teammate";

    const { data: company } = await supabase
      .from("companies")
      .select("name")
      .eq("id", invitationRow.company_id)
      .maybeSingle();

    const sendResult = await getEmailSender().send({
      to: invitationRow.email,
      subject: companyInvitationSubject({
        companyName: company?.name ?? "your company",
        inviterEmail,
        role: invitationRow.role,
        acceptUrl,
      }),
      html: companyInvitationHtml({
        companyName: company?.name ?? "your company",
        inviterEmail,
        role: invitationRow.role,
        acceptUrl,
      }),
      text: companyInvitationText({
        companyName: company?.name ?? "your company",
        inviterEmail,
        role: invitationRow.role,
        acceptUrl,
      }),
    });

    await supabase.from("email_outbox").insert({
      company_id: invitationRow.company_id,
      template: "company_invitation",
      to_email: invitationRow.email,
      status:
        sendResult.status === "sent"
          ? "sent"
          : sendResult.status === "failed"
            ? "failed"
            : "queued",
      provider_message_id: sendResult.providerMessageId,
      error: sendResult.error,
      sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
    });

    return {
      invitation: toCompanyInvitation(invitationRow, new Map()),
      acceptUrl,
      email: { status: sendResult.status, to: invitationRow.email },
    };
  });

// ---------------------------------------------------------------------------
// revokeCompanyInvitation - authenticated, RLS as the calling owner
// ---------------------------------------------------------------------------

const revokeCompanyInvitationSchema = z.object({ invitationId: z.string().uuid() });

/** Revokes a pending or expired invitation so its link can never be accepted. Only callable by an owner of the invitation's company. */
export const revokeCompanyInvitation = createServerFn({ method: "POST" })
  .validator(revokeCompanyInvitationSchema)
  .handler(async ({ data }): Promise<{ status: "revoked" }> => {
    const supabase = await getRequestScopedClient();
    const { error } = await supabase.rpc("revoke_company_invitation", {
      invitation_id: data.invitationId,
    });
    if (error) throw new Error(error.message);
    return { status: "revoked" };
  });

// ---------------------------------------------------------------------------
// acceptCompanyInvitation - authenticated (the invitee), RLS-adjacent via a
// SECURITY DEFINER RPC since the invitee is not yet a member of the company
// ---------------------------------------------------------------------------

const acceptCompanyInvitationSchema = z.object({ token: z.string().min(1) });

export interface AcceptCompanyInvitationResult {
  companyId: string;
  role: CompanyMemberRole;
}

/**
 * Redeems an invitation link. Must be called by an already-authenticated
 * session (the future accept-invite.$token.tsx route is expected to send an
 * unauthenticated visitor through sign-in/sign-up first, then call this) -
 * accept_company_invitation() reads the caller's own email from auth.users
 * (never from client input) and rejects with 'this invitation was sent to a
 * different email address' if it does not match the invitation's locked
 * email, case-insensitively. On success, inserts the company_members row and
 * marks the invitation accepted atomically inside that one RPC call.
 */
export const acceptCompanyInvitation = createServerFn({ method: "POST" })
  .validator(acceptCompanyInvitationSchema)
  .handler(async ({ data }): Promise<AcceptCompanyInvitationResult> => {
    const supabase = await getRequestScopedClient();
    const tokenHash = await hashToken(data.token);

    const { data: result, error } = await supabase.rpc("accept_company_invitation", {
      p_token_hash: tokenHash,
    });

    if (error || !result) {
      throw new Error(error?.message ?? "This invitation link is no longer valid.");
    }

    const parsed = result as unknown as { companyId: string; role: CompanyMemberRole };
    return { companyId: parsed.companyId, role: parsed.role };
  });

// ---------------------------------------------------------------------------
// listCompanyMembers - authenticated, RLS as any member of the company
// ---------------------------------------------------------------------------

const listCompanyMembersSchema = z.object({ companyId: z.string().uuid() });

/**
 * Every company_members row for `companyId`, active and deactivated alike,
 * so an access screen can show a removed teammate as "removed" rather than
 * silently dropping them from the list. Visible to any member (not
 * owner-only) via company_members_select's existing RLS policy - mutation
 * (role change / removal) is owner-only, but seeing the roster is not.
 */
export const listCompanyMembers = createServerFn({ method: "GET" })
  .validator(listCompanyMembersSchema)
  .handler(async ({ data }): Promise<CompanyMemberSummary[]> => {
    const supabase = await getRequestScopedClient();
    const { data: rows, error } = await supabase
      .from("company_members")
      .select("id, user_id, role, last_active_at, created_at, deactivated_at")
      .eq("company_id", data.companyId)
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);

    const memberRows = (rows ?? []) as Array<{
      id: string;
      user_id: string;
      role: CompanyMemberRole;
      last_active_at: string | null;
      created_at: string;
      deactivated_at: string | null;
    }>;

    const userIds = memberRows.map((r) => r.user_id);
    const emailByUserId = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email")
        .in("id", userIds);
      for (const p of (profiles ?? []) as Array<{ id: string; email: string }>) {
        emailByUserId.set(p.id, p.email);
      }
    }

    return memberRows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      email: emailByUserId.get(row.user_id) ?? null,
      role: row.role,
      isActive: row.deactivated_at === null,
      lastActiveAt: row.last_active_at,
      createdAt: row.created_at,
    }));
  });

// ---------------------------------------------------------------------------
// changeCompanyMemberRole / removeCompanyMember / transferCompanyOwnership -
// authenticated, RLS-adjacent via SECURITY DEFINER RPCs (see this file's top
// docblock for why - atomic audit-row-with-mutation, not "RLS is enough")
// ---------------------------------------------------------------------------

const changeCompanyMemberRoleSchema = z.object({
  memberId: z.string().uuid(),
  newRole: z.enum(["owner", "risk_manager", "project_engineer", "read_only"]),
});

/**
 * Changes an existing member's role. Only callable by an owner of that
 * member's company (change_company_member_role() checks this explicitly).
 * If this change would leave the company with zero active owners, the
 * underlying statement-level trigger (company_members_guard_last_owner_trg)
 * rejects it and no row is changed - see transferCompanyOwnership() below
 * for the one-statement path that legitimately swaps who the sole owner is.
 */
export const changeCompanyMemberRole = createServerFn({ method: "POST" })
  .validator(changeCompanyMemberRoleSchema)
  .handler(async ({ data }): Promise<CompanyMemberSummary> => {
    const supabase = await getRequestScopedClient();
    const { data: row, error } = await supabase.rpc("change_company_member_role", {
      target_member_id: data.memberId,
      new_role: data.newRole,
    });

    if (error || !row) throw new Error(error?.message ?? "Could not change this member's role.");

    const memberRow = row as unknown as {
      id: string;
      user_id: string;
      role: CompanyMemberRole;
      last_active_at: string | null;
      created_at: string;
      deactivated_at: string | null;
    };

    return {
      id: memberRow.id,
      userId: memberRow.user_id,
      email: null,
      role: memberRow.role,
      isActive: memberRow.deactivated_at === null,
      lastActiveAt: memberRow.last_active_at,
      createdAt: memberRow.created_at,
    };
  });

const removeCompanyMemberSchema = z.object({ memberId: z.string().uuid() });

/**
 * Deactivates (soft-removes) a member: sets deactivated_at/deactivated_by,
 * which immediately excludes them from current_company_ids()/
 * has_company_role() - they lose access to every RLS-gated table in the
 * schema, not just this one. The row itself is kept (not hard-deleted) so
 * audit_log's target_id keeps resolving and a later re-invite/accept can
 * reactivate the same row rather than violating the (company_id, user_id)
 * unique constraint. Only callable by an owner of the member's company;
 * blocked by the same last-active-owner trigger as changeCompanyMemberRole()
 * if this member is the company's sole active owner.
 */
export const removeCompanyMember = createServerFn({ method: "POST" })
  .validator(removeCompanyMemberSchema)
  .handler(async ({ data }): Promise<{ status: "removed" }> => {
    const supabase = await getRequestScopedClient();
    const { error } = await supabase.rpc("remove_company_member", {
      target_member_id: data.memberId,
    });
    if (error) throw new Error(error.message);
    return { status: "removed" };
  });

const transferCompanyOwnershipSchema = z.object({
  fromMemberId: z.string().uuid(),
  toMemberId: z.string().uuid(),
  demotedRole: z.enum(["risk_manager", "project_engineer", "read_only"]).default("risk_manager"),
});

/**
 * Promotes `toMemberId` to owner and demotes `fromMemberId` (who must
 * currently be an owner) to `demotedRole`, as a single atomic operation -
 * the "transfer ownership" action a future UI would offer as one click.
 *
 * Deliberately NOT implemented as two sequential
 * changeCompanyMemberRole() calls: demoting the sole existing owner first,
 * before the new owner is promoted, would be its own separate UPDATE
 * statement and would be correctly rejected by
 * company_members_guard_last_owner_trg as "removing the last active owner" -
 * even though the overall two-call sequence's end state is fine. This
 * function's underlying RPC (transfer_company_ownership) issues one UPDATE
 * covering both rows, so the statement-level trigger only ever sees the net
 * result (still exactly one owner) and allows it. See that trigger's
 * docblock in migration 20260916000500 for the full reasoning - this is the
 * same fix class Task 4 used for "last default requirement profile".
 */
export const transferCompanyOwnership = createServerFn({ method: "POST" })
  .validator(transferCompanyOwnershipSchema)
  .handler(async ({ data }): Promise<{ status: "transferred" }> => {
    const supabase = await getRequestScopedClient();
    const { error } = await supabase.rpc("transfer_company_ownership", {
      from_member_id: data.fromMemberId,
      to_member_id: data.toMemberId,
      demoted_role: data.demotedRole,
    });
    if (error) throw new Error(error.message);
    return { status: "transferred" };
  });

/**
 * Only exported for the anonymous accept-invite route the future UI task
 * builds: it needs a service-role read of "what company/role does this
 * token point to" to render an accept screen BEFORE the visitor is
 * necessarily signed in (accept_company_invitation() itself requires an
 * authenticated caller, so it cannot be used for that preview). Bypasses
 * RLS deliberately - the possession of the raw token is itself the
 * credential, the same trust model resolveUploadToken() in
 * vendorUploadRequests.ts already uses for the anonymous vendor link. Never
 * returns the token hash itself, and returns nothing at all (null) for an
 * invalid/unknown token - callers must not distinguish "expired" from
 * "never existed" any more than resolveUploadToken()'s
 * INVALID_TOKEN_MESSAGE does.
 */
export async function previewCompanyInvitationByToken(token: string): Promise<{
  companyName: string;
  email: string;
  role: CompanyMemberRole;
  status: CompanyInvitation["status"];
} | null> {
  const tokenHash = await hashToken(token);
  const supabase = await getServiceRoleClient();
  const { data } = await supabase
    .from("company_invitations")
    .select("email, role, status, expires_at, companies ( name )")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!data) return null;
  const row = data as unknown as {
    email: string;
    role: CompanyMemberRole;
    status: CompanyInvitationRow["status"];
    expires_at: string;
    companies: { name: string } | null;
  };

  return {
    companyName: row.companies?.name ?? "this company",
    email: row.email,
    role: row.role,
    status: displayStatus({
      status: row.status,
      expires_at: row.expires_at,
    } as CompanyInvitationRow),
  };
}
