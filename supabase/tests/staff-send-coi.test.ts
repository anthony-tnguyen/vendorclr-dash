import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Staff send COI (20261009160000): a platform admin may prepare_contact_request
 * for a customer's vendor even though they belong to no company. The widened
 * vendor_upload_requests / email_outbox policies let the inserts land.
 */

const STAFF = "a1111111-1111-1111-1111-111111111111";
const OWNER = "b2222222-2222-2222-2222-222222222222";
const OUTSIDER = "d4444444-4444-4444-4444-444444444444";

let db: PGlite;
let companyId: string;
let vendorId: string;
let contactId: string;

async function raiseMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

beforeEach(async () => {
  db = await createTestDb();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [
    STAFF,
    "staff@vendorclr.com",
  ]);
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [STAFF]);
  await signUp(db, { id: OWNER, email: "owner@acme.test", companyName: "Acme" });
  await signUp(db, { id: OUTSIDER, email: "nobody@rival.test" });
  companyId = await companyIdFor(db, OWNER);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Bay Steel', 'Structural Steel') returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;

  const contact = await db.query<{ id: string }>(
    `insert into public.contacts (company_id, name, email) values ($1, 'Sam Broker', 'sam@bay.test') returning id`,
    [companyId],
  );
  contactId = contact.rows[0]!.id;
  await db.query(
    `insert into public.vendor_contacts (company_id, vendor_id, contact_id, role) values ($1, $2, $3, 'operational')`,
    [companyId, vendorId, contactId],
  );
}, 60_000);

describe("prepare_contact_request as staff", () => {
  it("lets a platform admin create an upload request for a customer's vendor", async () => {
    await asUser(
      db,
      STAFF,
      `select public.prepare_contact_request($1, array[$2]::uuid[], 'renewal', 'tokenhash-staff', now() + interval '7 days')`,
      [vendorId, contactId],
    );
    const req = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_upload_requests where vendor_id = $1 and company_id = $2`,
      [vendorId, companyId],
    );
    expect(req.rows[0]?.n).toBe(1);
  });

  it("still refuses a non-staff caller who is not a member of the company", async () => {
    const message = await raiseMessage(() =>
      asUser(
        db,
        OUTSIDER,
        `select public.prepare_contact_request($1, array[$2]::uuid[], 'renewal', 'tokenhash-nope', now() + interval '7 days')`,
        [vendorId, contactId],
      ),
    );
    expect(message).toMatch(/not authorized|not found/i);
  });
});
