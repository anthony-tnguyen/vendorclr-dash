import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * Task 7 - contacts / vendor_contacts / suppressed_recipients
 * (20260916000600_contacts_and_suppression.sql), plus the
 * handle_bounce_suppression() trigger that turns a bounce/complaint
 * email_delivery_events row into an active suppression and a task.
 *
 * sendRequest() itself (src/workflows/communications.ts) is a
 * createServerFn - not exercisable here, same as createUploadRequest() -
 * so what's covered is everything the schema itself is responsible for:
 * the cross-tenant integrity triggers, RLS, and - the highest-value piece -
 * that a bounce/complaint genuinely produces an active suppression row a
 * future sendRequest() call would see.
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let alicesCompany: string;
let bobsCompany: string;
let alicesVendor: string;
let bobsVendor: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: ALICE, email: "alice@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, { id: BOB, email: "bob@rival.test", companyName: "Rival Construction" });
  alicesCompany = await companyIdFor(db, ALICE);
  bobsCompany = await companyIdFor(db, BOB);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Structural Steel', 'Structural Steel')
     returning id`,
    [alicesCompany],
  );
  alicesVendor = vendor.rows[0]!.id;

  const rivalVendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Rival Roofing', 'Roofing')
     returning id`,
    [bobsCompany],
  );
  bobsVendor = rivalVendor.rows[0]!.id;
}, 60_000);

describe("contacts", () => {
  it("lets a write-role member create a contact for their own company", async () => {
    const rows = await asUser<{ id: string; email: string }>(
      db,
      ALICE,
      `insert into public.contacts (company_id, name, email) values ($1, 'Dana Corbett', 'Dana@Corbett.example')
       returning id, email`,
      [alicesCompany],
    );
    expect(rows[0]?.email).toBe("Dana@Corbett.example");
  });

  it("refuses a contact naming another company's id", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        BOB,
        `insert into public.contacts (company_id, name, email) values ($1, 'Eve', 'eve@example.com')`,
        [alicesCompany],
      ),
    );
  });

  it("rejects an email with no @", async () => {
    await expect(
      asUser(
        db,
        ALICE,
        `insert into public.contacts (company_id, name, email) values ($1, 'No Email', 'not-an-email')`,
        [alicesCompany],
      ),
    ).rejects.toThrow();
  });

  it("is invisible to a rival company", async () => {
    const rival = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.contacts where company_id = $1`,
      [alicesCompany],
    );
    expect(rival[0]?.n).toBe(0);
  });
});

describe("vendor_contacts", () => {
  let contactId: string;

  beforeAll(async () => {
    const rows = await asUser<{ id: string }>(
      db,
      ALICE,
      `insert into public.contacts (company_id, name, email) values ($1, 'Broker Bea', 'bea@brokerco.example')
       returning id`,
      [alicesCompany],
    );
    contactId = rows[0]!.id;
  });

  it("links a contact to a vendor with a role", async () => {
    const rows = await asUser<{ role: string }>(
      db,
      ALICE,
      `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role)
       values ($1, $2, $3, 'broker') returning role`,
      [alicesCompany, alicesVendor, contactId],
    );
    expect(rows[0]?.role).toBe("broker");
  });

  it("lets the same contact carry a second, different role on the same vendor", async () => {
    const rows = await asUser<{ role: string }>(
      db,
      ALICE,
      `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role)
       values ($1, $2, $3, 'secondary') returning role`,
      [alicesCompany, alicesVendor, contactId],
    );
    expect(rows[0]?.role).toBe("secondary");
  });

  it("rejects an exact duplicate (vendor, contact, role)", async () => {
    await expect(
      asUser(
        db,
        ALICE,
        `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role)
         values ($1, $2, $3, 'broker')`,
        [alicesCompany, alicesVendor, contactId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a role outside the known set", async () => {
    await expect(
      asUser(
        db,
        ALICE,
        `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role)
         values ($1, $2, $3, 'owner')`,
        [alicesCompany, alicesVendor, contactId],
      ),
    ).rejects.toThrow();
  });

  it("rejects linking a contact to another company's vendor, even with a matching company_id claim", async () => {
    // contactId belongs to Alice's company; bobsVendor belongs to Bob's.
    // The FKs alone would allow this (both rows exist); only
    // assert_company_matches_contact()/assert_company_matches_vendor() catch
    // the cross-tenant mismatch between company_id and the two parents.
    await expect(
      asUser(
        db,
        ALICE,
        `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role)
         values ($1, $2, $3, 'operational')`,
        [alicesCompany, bobsVendor, contactId],
      ),
    ).rejects.toThrow(/does not match|does not exist/);
  });

  it("is invisible to a rival company", async () => {
    const rival = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.vendor_contacts where vendor_id = $1`,
      [alicesVendor],
    );
    expect(rival[0]?.n).toBe(0);
  });
});

describe("suppressed_recipients + handle_bounce_suppression", () => {
  let outboxId: string;

  beforeAll(async () => {
    const outbox = await db.query<{ id: string }>(
      `insert into public.email_outbox (company_id, vendor_id, template, to_email, provider_message_id, status)
       values ($1, $2, 'renewal_request', 'Dana@Corbett.example', 'resend-msg-suppress-1', 'sent')
       returning id`,
      [alicesCompany, alicesVendor],
    );
    outboxId = outbox.rows[0]!.id;
  });

  it("does nothing for a non-outcome event (sent/delivered/delivery_delayed)", async () => {
    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'delivered', now())`,
      [alicesCompany, outboxId],
    );

    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.suppressed_recipients where company_id = $1`,
      [alicesCompany],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("creates an active suppression, normalized to lowercase, on a bounce", async () => {
    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'bounced', now())`,
      [alicesCompany, outboxId],
    );

    const rows = await db.query<{ email: string; reason: string }>(
      `select email, reason from public.suppressed_recipients where company_id = $1`,
      [alicesCompany],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.email).toBe("dana@corbett.example");
    expect(rows.rows[0]?.reason).toBe("bounced");
  });

  it("also opens an operational task flagging the bounce", async () => {
    const rows = await db.query<{
      title: string;
      priority: string;
      status: string;
      vendor_id: string;
    }>(
      `select title, priority, status, vendor_id from public.tasks
       where company_id = $1 and vendor_id = $2
       order by created_at desc limit 1`,
      [alicesCompany, alicesVendor],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.priority).toBe("high");
    expect(rows.rows[0]?.status).toBe("open");
    expect(rows.rows[0]?.title).toMatch(/bounced/i);
  });

  it("a second bounce refreshes the same suppression row rather than duplicating it", async () => {
    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'bounced', now())`,
      [alicesCompany, outboxId],
    );

    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.suppressed_recipients where company_id = $1 and email = 'dana@corbett.example'`,
      [alicesCompany],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("a complaint on a different address also suppresses, with reason 'complained'", async () => {
    const outbox2 = await db.query<{ id: string }>(
      `insert into public.email_outbox (company_id, vendor_id, template, to_email, provider_message_id, status)
       values ($1, $2, 'renewal_request', 'complainer@example.com', 'resend-msg-suppress-2', 'sent')
       returning id`,
      [alicesCompany, alicesVendor],
    );

    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'complained', now())`,
      [alicesCompany, outbox2.rows[0]!.id],
    );

    const rows = await db.query<{ reason: string }>(
      `select reason from public.suppressed_recipients where company_id = $1 and email = 'complainer@example.com'`,
      [alicesCompany],
    );
    expect(rows.rows[0]?.reason).toBe("complained");
  });

  it("a manual suppression can be inserted directly by a company writer", async () => {
    const rows = await asUser<{ reason: string }>(
      db,
      ALICE,
      `insert into public.suppressed_recipients (company_id, email, reason) values ($1, 'manual@example.com', 'manual')
       returning reason`,
      [alicesCompany],
    );
    expect(rows[0]?.reason).toBe("manual");
  });

  it("a company writer can clear a suppression", async () => {
    await asUser(
      db,
      ALICE,
      `delete from public.suppressed_recipients where company_id = $1 and email = 'manual@example.com'`,
      [alicesCompany],
    );
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.suppressed_recipients where company_id = $1 and email = 'manual@example.com'`,
      [alicesCompany],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("rejects a reason outside the known set", async () => {
    await expect(
      asUser(
        db,
        ALICE,
        `insert into public.suppressed_recipients (company_id, email, reason) values ($1, 'x@example.com', 'spam')`,
        [alicesCompany],
      ),
    ).rejects.toThrow();
  });

  it("is invisible to a rival company", async () => {
    const rival = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.suppressed_recipients where company_id = $1`,
      [alicesCompany],
    );
    expect(rival[0]?.n).toBe(0);
  });

  it("rejects a company_id that does not match the owning email_outbox row's company", async () => {
    await expect(
      db.query(
        `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
         values ($1, $2, 'bounced', now())`,
        [bobsCompany, outboxId],
      ),
    ).rejects.toThrow(/does not match/);
  });
});

describe("audit_log", () => {
  it("accepts the contact_request_sent action added by this migration", async () => {
    const rows = await db.query<{ action: string }>(
      `insert into public.audit_log (company_id, action, target_type, target_id)
       values ($1, 'contact_request_sent', 'vendor', $2) returning action`,
      [alicesCompany, alicesVendor],
    );
    expect(rows.rows[0]?.action).toBe("contact_request_sent");
  });
});
