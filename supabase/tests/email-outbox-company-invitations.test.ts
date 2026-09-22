import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * 20260922130000_email_outbox_company_invitations.sql - company-invitation
 * sends are recorded in email_outbox with no vendor_id, and a bounce on one
 * still suppresses the address.
 *
 * The inserts below run as the owner through RLS with the same columns
 * inviteCompanyMember()/resendCompanyInvitation() send
 * (src/workflows/companyInvitations.ts), since that insert failing silently
 * was the original bug.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const RIVAL_OWNER = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let companyId: string;
let rivalCompanyId: string;
let vendorId: string;
let rivalVendorId: string;

async function insertInvitationOutboxAsOwner(
  userId: string,
  company: string,
  toEmail: string,
  providerMessageId: string | null = null,
): Promise<string> {
  const rows = await asUser<{ id: string }>(
    db,
    userId,
    `insert into public.email_outbox
       (company_id, template, to_email, status, provider_message_id, error, sent_at)
     values ($1, 'company_invitation', $2, 'sent', $3, null, now())
     returning id`,
    [company, toEmail, providerMessageId],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, {
    id: RIVAL_OWNER,
    email: "owner@rival.test",
    companyName: "Rival Construction",
  });
  companyId = await companyIdFor(db, OWNER);
  rivalCompanyId = await companyIdFor(db, RIVAL_OWNER);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Steel', 'Roofing')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;

  const rivalVendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Rival Roofing', 'Roofing')
     returning id`,
    [rivalCompanyId],
  );
  rivalVendorId = rivalVendor.rows[0]!.id;
}, 60_000);

describe("email_outbox - company_invitation rows", () => {
  it("lets an owner record an invitation send with no vendor_id, through RLS", async () => {
    const id = await insertInvitationOutboxAsOwner(OWNER, companyId, "new.hire@halstead.test");

    const rows = await db.query<{ vendor_id: string | null; template: string }>(
      `select vendor_id, template from public.email_outbox where id = $1`,
      [id],
    );
    expect(rows.rows[0]).toEqual({ vendor_id: null, template: "company_invitation" });
  });

  it("is invisible to a different company", async () => {
    const rival = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.email_outbox where template = 'company_invitation'`,
    );
    expect(rival[0]?.n).toBe(0);
  });

  it("still refuses an invitation row for a company the caller does not belong to", async () => {
    await expectDeniedByRls(() =>
      insertInvitationOutboxAsOwner(RIVAL_OWNER, companyId, "sneaky@rival.test"),
    );
  });

  it("still rejects a template outside the allow-list", async () => {
    await expect(
      db.query(
        `insert into public.email_outbox (company_id, template, to_email)
         values ($1, 'weekly_digest', 'someone@halstead.test')`,
        [companyId],
      ),
    ).rejects.toThrow(/email_outbox_template_check/);
  });

  it("still requires a vendor for every vendor-scoped template", async () => {
    await expect(
      db.query(
        `insert into public.email_outbox (company_id, template, to_email)
         values ($1, 'renewal_request', 'dana@corbett.example')`,
        [companyId],
      ),
    ).rejects.toThrow(/email_outbox_vendor_required_check/);
  });
});

describe("email_outbox - company/vendor consistency, with vendor_id now optional", () => {
  it("accepts a vendor-scoped row whose vendor belongs to the same company", async () => {
    const rows = await db.query<{ id: string }>(
      `insert into public.email_outbox (company_id, vendor_id, template, to_email)
       values ($1, $2, 'renewal_request', 'dana@corbett.example') returning id`,
      [companyId, vendorId],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("rejects a vendor owned by a different company", async () => {
    await expect(
      db.query(
        `insert into public.email_outbox (company_id, vendor_id, template, to_email)
         values ($1, $2, 'renewal_request', 'dana@corbett.example')`,
        [companyId, rivalVendorId],
      ),
    ).rejects.toThrow(/does not match the owning company/);
  });

  it("rejects a vendor that does not exist", async () => {
    await expect(
      db.query(
        `insert into public.email_outbox (company_id, vendor_id, template, to_email)
         values ($1, gen_random_uuid(), 'renewal_request', 'dana@corbett.example')`,
        [companyId],
      ),
    ).rejects.toThrow();
  });

  it("rejects attaching a vendor from another company to an invitation row later", async () => {
    const id = await insertInvitationOutboxAsOwner(OWNER, companyId, "later@halstead.test");
    await expect(
      db.query(`update public.email_outbox set vendor_id = $1 where id = $2`, [rivalVendorId, id]),
    ).rejects.toThrow(/does not match the owning company/);
  });

  it.each(["anon", "authenticated"])(
    "%s cannot execute assert_company_matches_optional_vendor() directly",
    async (role) => {
      const rows = await db.query<{ allowed: boolean }>(
        `select has_function_privilege($1, 'public.assert_company_matches_optional_vendor()', 'execute') allowed`,
        [role],
      );
      expect(rows.rows[0]?.allowed).toBe(false);
    },
  );
});

describe("handle_bounce_suppression() - invitation bounces", () => {
  let invitationOutboxId: string;

  beforeAll(async () => {
    invitationOutboxId = await insertInvitationOutboxAsOwner(
      OWNER,
      companyId,
      "Bouncy.Hire@Halstead.test",
      "resend-invite-bounce-1",
    );
    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'bounced', now())`,
      [companyId, invitationOutboxId],
    );
  });

  it("suppresses the invited address even though the send has no vendor", async () => {
    const rows = await db.query<{ reason: string }>(
      `select reason from public.suppressed_recipients where company_id = $1 and email = $2`,
      [companyId, "bouncy.hire@halstead.test"],
    );
    expect(rows.rows).toEqual([{ reason: "bounced" }]);
  });

  it("opens a vendor-less task whose title names the address but no vendor", async () => {
    const rows = await db.query<{ title: string; vendor_id: string | null; priority: string }>(
      `select title, vendor_id, priority from public.tasks
       where company_id = $1 and title like '%Bouncy.Hire@Halstead.test%'`,
      [companyId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.vendor_id).toBeNull();
    expect(rows.rows[0]?.priority).toBe("high");
    expect(rows.rows[0]?.title).toBe(
      "Email bounced for Bouncy.Hire@Halstead.test - contact suppressed from automated sends",
    );
  });

  it("keeps the vendor name in the task title for a vendor-scoped bounce", async () => {
    const outbox = await db.query<{ id: string }>(
      `insert into public.email_outbox (company_id, vendor_id, template, to_email, status)
       values ($1, $2, 'renewal_request', 'ap@corbett.example', 'sent') returning id`,
      [companyId, vendorId],
    );
    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'complained', now())`,
      [companyId, outbox.rows[0]!.id],
    );

    const rows = await db.query<{ title: string; vendor_id: string | null }>(
      `select title, vendor_id from public.tasks
       where company_id = $1 and title like '%ap@corbett.example%'`,
      [companyId],
    );
    expect(rows.rows).toEqual([
      {
        title:
          "Email complained for Corbett Steel (ap@corbett.example) - contact suppressed from automated sends",
        vendor_id: vendorId,
      },
    ]);
  });
});
