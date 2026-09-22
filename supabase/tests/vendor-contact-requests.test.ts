import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import {
  asUser,
  companyIdFor,
  createTestDb,
  migrationFiles,
  readMigration,
  SKIPPED_IN_PGLITE,
  signUp,
} from "./harness";

/**
 * 20260922120000_vendor_contacts_request_delivery.sql - the database half of
 * the multi-recipient request flow (sendRequest(), communications.ts).
 *
 * prepare_contact_request() is where the recipient list is re-derived and
 * suppression is enforced, so the security guarantees the UI relies on are
 * tested here against real Postgres + RLS rather than against a mock:
 * suppressed recipients never become sendable, unrelated or cross-company
 * contact ids reject the whole call, a resend mints a new request and retires
 * the old token, and every excluded recipient is recorded.
 */

const MIGRATION = "20260922120000_vendor_contacts_request_delivery.sql";
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const READER = "33333333-3333-3333-3333-333333333333";

let db: PGlite;
let aliceCo: string;
let bobCo: string;
let steelVendor: string;
let roofVendor: string;
let bobsVendor: string;

async function contactFor(vendorId: string, role: string): Promise<string> {
  const rows = await db.query<{ contact_id: string }>(
    `select contact_id from public.vendor_contacts where vendor_id = $1 and role = $2`,
    [vendorId, role],
  );
  return rows.rows[0]!.contact_id;
}

async function addContact(
  companyId: string,
  vendorId: string,
  role: string,
  name: string,
  email: string,
): Promise<string> {
  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (company_id, name, email, organization) values ($1, $2, $3, 'Agency')
     on conflict (company_id, lower(btrim(email))) do update set name = excluded.name
     returning id`,
    [companyId, name, email],
  );
  const id = contact.rows[0]!.id;
  await db.query(
    `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role) values ($1, $2, $3, $4)`,
    [companyId, vendorId, id, role],
  );
  return id;
}

let tokenCounter = 0;
function prepare(
  userId: string,
  vendorId: string,
  contactIds: string[],
  resendOf: string | null = null,
) {
  tokenCounter += 1;
  return asUser<{ result: RecipientPayload }>(
    db,
    userId,
    `select public.prepare_contact_request($1, $2::uuid[], 'renewal', $3, now() + interval '14 days', $4) as result`,
    [vendorId, contactIds, `token-hash-${tokenCounter}`, resendOf],
  ).then((rows) => rows[0]!.result);
}

interface RecipientPayload {
  requestId: string;
  companyId: string;
  vendorName: string;
  recipients: Array<{
    contactId: string;
    email: string;
    role: string;
    suppressionReason: string | null;
  }>;
}

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: ALICE, email: "alice@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, { id: BOB, email: "bob@rival.test", companyName: "Rival Construction" });
  await signUp(db, { id: READER, email: "reader@halstead.test" });
  aliceCo = await companyIdFor(db, ALICE);
  bobCo = await companyIdFor(db, BOB);
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only')`,
    [aliceCo, READER],
  );

  // contact_email on insert -> operational contact via the vendors trigger.
  steelVendor = (
    await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade, contact_name, contact_email)
       values ($1, 'Corbett Steel', 'Structural Steel', 'Dana Corbett', 'dana@corbett.example') returning id`,
      [aliceCo],
    )
  ).rows[0]!.id;
  roofVendor = (
    await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade, contact_name, contact_email)
       values ($1, 'Apex Roofing', 'Roofing', 'Ray Apex', 'ray@apex.example') returning id`,
      [aliceCo],
    )
  ).rows[0]!.id;
  bobsVendor = (
    await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade, contact_name, contact_email)
       values ($1, 'Rival Glass', 'Glazing', 'Gil Rival', 'gil@rivalglass.example') returning id`,
      [bobCo],
    )
  ).rows[0]!.id;
}, 60_000);

describe("vendor contact_email -> operational contact", () => {
  it("links a new vendor's contact_email as its operational contact", async () => {
    const rows = await db.query<{ name: string; email: string }>(
      `select c.name, c.email from public.vendor_contacts vc join public.contacts c on c.id = vc.contact_id
       where vc.vendor_id = $1 and vc.role = 'operational'`,
      [steelVendor],
    );
    expect(rows.rows).toEqual([{ name: "Dana Corbett", email: "dana@corbett.example" }]);
  });

  it("reuses one contact row for an address shared across vendors instead of duplicating it", async () => {
    const shared = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade, contact_name, contact_email)
       values ($1, 'Corbett Steel East', 'Structural Steel', 'Dana C.', ' DANA@corbett.example ') returning id`,
      [aliceCo],
    );
    const count = await db.query<{ n: number }>(
      `select count(*)::int n from public.contacts where company_id = $1 and lower(email) = 'dana@corbett.example'`,
      [aliceCo],
    );
    expect(count.rows[0]!.n).toBe(1);
    expect(await contactFor(shared.rows[0]!.id, "operational")).toBe(
      await contactFor(steelVendor, "operational"),
    );
  });

  it("refuses a second contact row with the same address (case/space-insensitive)", async () => {
    await expect(
      asUser(
        db,
        ALICE,
        `insert into public.contacts (company_id, name, email) values ($1, 'Dup', 'Dana@Corbett.example')`,
        [aliceCo],
      ),
    ).rejects.toThrow(/duplicate key|unique/);
  });
});

describe("prepare_contact_request - recipients and suppression", () => {
  let brokerId: string;
  let bouncedId: string;
  let complainedId: string;
  let operationalId: string;

  beforeAll(async () => {
    operationalId = await contactFor(steelVendor, "operational");
    // A broker reused across two vendors - one contact row, two links.
    brokerId = await addContact(
      aliceCo,
      steelVendor,
      "broker",
      "Bea Broker",
      "bea@brokerco.example",
    );
    await db.query(
      `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role) values ($1, $2, $3, 'broker')`,
      [aliceCo, roofVendor, brokerId],
    );
    bouncedId = await addContact(
      aliceCo,
      steelVendor,
      "secondary",
      "Bounce Bo",
      "bo@bounced.example",
    );
    complainedId = await addContact(
      aliceCo,
      steelVendor,
      "secondary",
      "Cam Plain",
      "cam@complained.example",
    );
    await db.query(
      `insert into public.suppressed_recipients (company_id, email, reason) values
         ($1, 'BO@bounced.example', 'bounced'), ($1, 'cam@complained.example', 'complained')`,
      [aliceCo],
    );
  });

  it("1. a bounced operational contact cannot receive a request", async () => {
    const vendor = (
      await db.query<{ id: string }>(
        `insert into public.vendors (company_id, name, trade, contact_name, contact_email)
         values ($1, 'Dead Letter Drywall', 'Concrete', 'Dee', 'dee@deadletter.example') returning id`,
        [aliceCo],
      )
    ).rows[0]!.id;
    await db.query(
      `insert into public.suppressed_recipients (company_id, email, reason) values ($1, 'dee@deadletter.example', 'bounced')`,
      [aliceCo],
    );
    const dee = await contactFor(vendor, "operational");

    await expect(prepare(ALICE, vendor, [dee])).rejects.toThrow(/suppressed/);
    const requests = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_upload_requests where vendor_id = $1`,
      [vendor],
    );
    expect(requests.rows[0]!.n).toBe(0);
  });

  it("2. a complained address cannot receive a request and is recorded as excluded", async () => {
    const result = await prepare(ALICE, steelVendor, [operationalId, complainedId]);
    const cam = result.recipients.find((r) => r.contactId === complainedId);
    expect(cam?.suppressionReason).toBe("complained");

    const outbox = await db.query<{ status: string; recipient_role: string; contact_id: string }>(
      `select status, recipient_role, contact_id from public.email_outbox where upload_request_id = $1`,
      [result.requestId],
    );
    expect(outbox.rows).toEqual([
      { status: "suppressed", recipient_role: "secondary", contact_id: complainedId },
    ]);
  });

  it("3. a clean broker can receive a request", async () => {
    const result = await prepare(ALICE, roofVendor, [brokerId]);
    expect(result.recipients).toEqual([
      expect.objectContaining({ contactId: brokerId, role: "broker", suppressionReason: null }),
    ]);
  });

  it("4. multiple recipients share one request (one token)", async () => {
    const result = await prepare(ALICE, steelVendor, [operationalId, brokerId, bouncedId]);
    expect(result.recipients.map((r) => [r.role, r.suppressionReason])).toEqual([
      ["operational", null],
      ["broker", null],
      ["secondary", "bounced"],
    ]);
    const requests = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_upload_requests where id = $1`,
      [result.requestId],
    );
    expect(requests.rows[0]!.n).toBe(1);
  });

  it("5. rejects a contact id linked to a different vendor, creating nothing", async () => {
    const roofOperational = await contactFor(roofVendor, "operational");
    const before = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_upload_requests`,
    );
    await expect(prepare(ALICE, steelVendor, [operationalId, roofOperational])).rejects.toThrow(
      /not a contact of this vendor/,
    );
    const after = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_upload_requests`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("6. rejects another company's contact id", async () => {
    const bobsContact = await contactFor(bobsVendor, "operational");
    await expect(prepare(ALICE, steelVendor, [bobsContact])).rejects.toThrow(
      /not a contact of this vendor/,
    );
  });

  it("6b. hides another company's vendor entirely", async () => {
    await expect(prepare(BOB, steelVendor, [operationalId])).rejects.toThrow(/Vendor not found/);
  });

  it("refuses a read-only member", async () => {
    await expect(prepare(READER, steelVendor, [operationalId])).rejects.toThrow(/not authorized/);
  });

  it("rejects an empty recipient list", async () => {
    await expect(prepare(ALICE, steelVendor, [])).rejects.toThrow(/at least one recipient/);
  });
});

describe("prepare_contact_request - resend", () => {
  it("7. a resend creates a new request with its own token and cancels the old one", async () => {
    const operational = await contactFor(roofVendor, "operational");
    const first = await prepare(ALICE, roofVendor, [operational]);
    const second = await prepare(ALICE, roofVendor, [operational], first.requestId);

    expect(second.requestId).not.toBe(first.requestId);
    const rows = await db.query<{
      id: string;
      status: string;
      token_hash: string;
      resend_of_request_id: string | null;
    }>(
      `select id, status, token_hash, resend_of_request_id from public.vendor_upload_requests where id = any($1::uuid[])`,
      [[first.requestId, second.requestId]],
    );
    const old = rows.rows.find((r) => r.id === first.requestId)!;
    const fresh = rows.rows.find((r) => r.id === second.requestId)!;
    expect(old.status).toBe("cancelled");
    expect(fresh.status).toBe("pending");
    expect(fresh.token_hash).not.toBe(old.token_hash);
    expect(fresh.resend_of_request_id).toBe(first.requestId);
  });

  it("does not cancel a request the vendor already uploaded against", async () => {
    const operational = await contactFor(roofVendor, "operational");
    const first = await prepare(ALICE, roofVendor, [operational]);
    await db.query(`update public.vendor_upload_requests set status = 'uploaded' where id = $1`, [
      first.requestId,
    ]);
    await prepare(ALICE, roofVendor, [operational], first.requestId);
    const row = await db.query<{ status: string }>(
      `select status from public.vendor_upload_requests where id = $1`,
      [first.requestId],
    );
    expect(row.rows[0]!.status).toBe("uploaded");
  });

  it("refuses to resend a request that belongs to another vendor", async () => {
    const steelOperational = await contactFor(steelVendor, "operational");
    const roofOperational = await contactFor(roofVendor, "operational");
    const roofRequest = await prepare(ALICE, roofVendor, [roofOperational]);
    await expect(
      prepare(ALICE, steelVendor, [steelOperational], roofRequest.requestId),
    ).rejects.toThrow(/does not belong to this vendor/);
  });
});

describe("communication history + delivery events", () => {
  it("8. records sent, delivered, bounced and complained outcomes against the request's outbox rows", async () => {
    const operational = await contactFor(steelVendor, "operational");
    const result = await prepare(ALICE, steelVendor, [operational]);
    const outbox = await asUser<{ id: string }>(
      db,
      ALICE,
      `insert into public.email_outbox
         (company_id, vendor_id, upload_request_id, template, to_email, status, provider_message_id, contact_id, recipient_role)
       values ($1, $2, $3, 'renewal_request', 'dana@corbett.example', 'sent', 'msg-history-1', $4, 'operational')
       returning id`,
      [aliceCo, steelVendor, result.requestId, operational],
    );
    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'delivered', now())`,
      [aliceCo, outbox[0]!.id],
    );

    const history = await asUser<{
      status: string;
      recipient_role: string;
      events: string[];
      request_status: string;
    }>(
      db,
      ALICE,
      `select eo.status, eo.recipient_role,
              array(select event_type from public.email_delivery_events e where e.email_outbox_id = eo.id) events,
              r.status request_status
       from public.email_outbox eo join public.vendor_upload_requests r on r.id = eo.upload_request_id
       where eo.id = $1`,
      [outbox[0]!.id],
    );
    expect(history[0]).toEqual({
      status: "sent",
      recipient_role: "operational",
      events: ["delivered"],
      request_status: "pending",
    });
  });

  it("a bounce on a request email suppresses the address for the next request", async () => {
    const vendor = (
      await db.query<{ id: string }>(
        `insert into public.vendors (company_id, name, trade, contact_name, contact_email)
         values ($1, 'Later Bounce Electric', 'Electrical', 'Lee', 'lee@laterbounce.example') returning id`,
        [aliceCo],
      )
    ).rows[0]!.id;
    const lee = await contactFor(vendor, "operational");
    const first = await prepare(ALICE, vendor, [lee]);
    const outbox = await db.query<{ id: string }>(
      `insert into public.email_outbox (company_id, vendor_id, upload_request_id, template, to_email, status, contact_id, recipient_role)
       values ($1, $2, $3, 'renewal_request', 'lee@laterbounce.example', 'sent', $4, 'operational') returning id`,
      [aliceCo, vendor, first.requestId, lee],
    );
    await db.query(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'bounced', now())`,
      [aliceCo, outbox.rows[0]!.id],
    );
    const suppressed = await asUser<{ s: boolean }>(
      db,
      ALICE,
      `select public.is_email_suppressed($1, 'LEE@laterbounce.example') s`,
      [aliceCo],
    );
    expect(suppressed[0]!.s).toBe(true);
    await expect(prepare(ALICE, vendor, [lee])).rejects.toThrow(/suppressed/);
  });

  it("refuses an outbox row naming another company's contact", async () => {
    const bobsContact = await contactFor(bobsVendor, "operational");
    await expect(
      db.query(
        `insert into public.email_outbox (company_id, vendor_id, template, to_email, status, contact_id)
         values ($1, $2, 'renewal_request', 'x@example.com', 'queued', $3)`,
        [aliceCo, steelVendor, bobsContact],
      ),
    ).rejects.toThrow(/does not belong to company/);
  });
});

describe("is_email_suppressed", () => {
  it("does not leak another company's suppressions", async () => {
    const rows = await asUser<{ s: boolean }>(
      db,
      BOB,
      `select public.is_email_suppressed($1, 'bo@bounced.example') s`,
      [aliceCo],
    );
    expect(rows[0]!.s).toBe(false);
  });

  it("is not executable by anon", async () => {
    const grants = await db.query<{ ok: boolean }>(
      `select has_function_privilege('anon', 'public.is_email_suppressed(uuid, text)', 'execute') ok`,
    );
    expect(grants.rows[0]!.ok).toBe(false);
  });
});

describe("contact management audit", () => {
  it("records link, role change and unlink", async () => {
    const contact = await asUser<{ id: string }>(
      db,
      ALICE,
      `insert into public.contacts (company_id, name, email) values ($1, 'Audit Al', 'al@audit.example') returning id`,
      [aliceCo],
    );
    const link = await asUser<{ id: string }>(
      db,
      ALICE,
      `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role) values ($1, $2, $3, 'secondary') returning id`,
      [aliceCo, steelVendor, contact[0]!.id],
    );
    await asUser(db, ALICE, `update public.vendor_contacts set role = 'broker' where id = $1`, [
      link[0]!.id,
    ]);
    await asUser(db, ALICE, `delete from public.vendor_contacts where id = $1`, [link[0]!.id]);

    const actions = await db.query<{ action: string; actor_id: string }>(
      `select action, actor_id from public.audit_log where target_id = any($1::uuid[]) order by created_at, action`,
      [[contact[0]!.id, link[0]!.id]],
    );
    expect(actions.rows.map((r) => r.action).sort()).toEqual(
      [
        "contact_created",
        "vendor_contact_linked",
        "vendor_contact_role_changed",
        "vendor_contact_unlinked",
      ].sort(),
    );
    expect(actions.rows.every((r) => r.actor_id === ALICE)).toBe(true);
  });

  it("still lets a company with contacts be deleted", async () => {
    await db.query(`delete from public.companies where id = $1`, [bobCo]);
    const left = await db.query<{ n: number }>(
      `select count(*)::int n from public.contacts where company_id = $1`,
      [bobCo],
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe("migration: merging pre-existing duplicate contacts", () => {
  it("collapses duplicates into the oldest row and keeps every vendor link", async () => {
    const pre = await createTestDb({ stopBeforeMigration: MIGRATION });
    await signUp(pre, {
      id: ALICE,
      email: "alice@halstead.test",
      companyName: "Halstead Builders",
    });
    const co = await companyIdFor(pre, ALICE);
    const v1 = (
      await pre.query<{ id: string }>(
        `insert into public.vendors (company_id, name, trade) values ($1, 'V1', 'Roofing') returning id`,
        [co],
      )
    ).rows[0]!.id;
    const v2 = (
      await pre.query<{ id: string }>(
        `insert into public.vendors (company_id, name, trade, contact_name, contact_email)
         values ($1, 'V2', 'Roofing', 'Legacy Lu', 'lu@legacy.example') returning id`,
        [co],
      )
    ).rows[0]!.id;
    const older = (
      await pre.query<{ id: string }>(
        `insert into public.contacts (company_id, name, email, created_at) values ($1, 'Bea', 'bea@b.example', now() - interval '1 day') returning id`,
        [co],
      )
    ).rows[0]!.id;
    const newer = (
      await pre.query<{ id: string }>(
        `insert into public.contacts (company_id, name, email) values ($1, 'Bea Dup', ' BEA@b.example') returning id`,
        [co],
      )
    ).rows[0]!.id;
    const newest = (
      await pre.query<{ id: string }>(
        `insert into public.contacts (company_id, name, email, created_at) values ($1, 'Bea Dup 2', 'bea@B.example', now() + interval '1 day') returning id`,
        [co],
      )
    ).rows[0]!.id;
    // V1: the keeper and one duplicate both link as broker. V2: two
    // duplicates (neither the keeper) both link as broker - repointing both
    // would collide unless the migration dedupes the links first.
    await pre.query(
      `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role) values
         ($1, $2, $3, 'broker'), ($1, $2, $4, 'broker'), ($1, $5, $4, 'broker'), ($1, $5, $6, 'broker'),
         ($1, $5, $6, 'secondary')`,
      [co, v1, older, newer, v2, newest],
    );

    const files = migrationFiles();
    for (const file of files.slice(files.indexOf(MIGRATION))) {
      if (!SKIPPED_IN_PGLITE.includes(file)) await pre.exec(readMigration(file));
    }

    const contacts = await pre.query<{ id: string }>(
      `select id from public.contacts where company_id = $1 and lower(btrim(email)) = 'bea@b.example'`,
      [co],
    );
    expect(contacts.rows).toEqual([{ id: older }]);
    const links = await pre.query<{ vendor_id: string }>(
      `select vendor_id from public.vendor_contacts where contact_id = $1 and role = 'broker' order by vendor_id`,
      [older],
    );
    expect(links.rows.map((r) => r.vendor_id).sort()).toEqual([v1, v2].sort());
    const secondary = await pre.query<{ n: number }>(
      `select count(*)::int n from public.vendor_contacts where contact_id = $1 and vendor_id = $2 and role = 'secondary'`,
      [older, v2],
    );
    expect(secondary.rows[0]!.n).toBe(1);

    // Backfill: V2's Phase 0 contact_email is now its operational contact.
    const backfilled = await pre.query<{ email: string }>(
      `select c.email from public.vendor_contacts vc join public.contacts c on c.id = vc.contact_id
       where vc.vendor_id = $1 and vc.role = 'operational'`,
      [v2],
    );
    expect(backfilled.rows).toEqual([{ email: "lu@legacy.example" }]);
    await pre.close();
  }, 120_000);
});
