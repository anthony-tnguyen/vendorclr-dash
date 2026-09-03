import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * email_delivery_events (migration 19) and the widened email_outbox.status
 * enum - the record of what actually happened to a sent email, written
 * exclusively by the resend-webhook Edge Function on the service role. No
 * pg_cron/pg_net dependency here (unlike renewal reminders/automated
 * retry) - Resend calls this function directly over HTTP on its own
 * schedule, there is nothing to schedule from this side - so signature
 * verification and the actual webhook handling are what need the live
 * project; this file covers everything the schema itself is responsible
 * for.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const RIVAL_OWNER = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let companyId: string;
let rivalCompanyId: string;
let vendorId: string;
let outboxId: string;

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
    `insert into public.vendors (company_id, name, trade) values ($1, 'Bounce Test Vendor', 'Roofing')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;

  const outbox = await db.query<{ id: string }>(
    `insert into public.email_outbox (company_id, vendor_id, template, to_email, provider_message_id, status)
     values ($1, $2, 'renewal_request', 'dana@corbettsteel.example', 'resend-msg-1', 'sent')
     returning id`,
    [companyId, vendorId],
  );
  outboxId = outbox.rows[0]!.id;
}, 60_000);

describe("email_outbox.status", () => {
  it.each(["delivered", "bounced", "complained"])(
    "accepts %s, added in migration 19",
    async (status) => {
      const rows = await db.query<{ status: string }>(
        `update public.email_outbox set status = $1 where id = $2 returning status`,
        [status, outboxId],
      );
      expect(rows.rows[0]?.status).toBe(status);
    },
  );

  it("still rejects a status outside the widened allow-list", async () => {
    await expect(
      db.query(`update public.email_outbox set status = $1 where id = $2`, ["opened", outboxId]),
    ).rejects.toThrow();
  });
});

describe("email_delivery_events", () => {
  it("records an event for the owning company", async () => {
    const rows = await db.query<{ event_type: string }>(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'delivered', now()) returning event_type`,
      [companyId, outboxId],
    );
    expect(rows.rows[0]?.event_type).toBe("delivered");
  });

  it("rejects an event_type outside the known set", async () => {
    await expect(
      db.query(
        `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
         values ($1, $2, 'opened', now())`,
        [companyId, outboxId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a company_id that does not match the owning email_outbox row", async () => {
    await expect(
      db.query(
        `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
         values ($1, $2, 'bounced', now())`,
        [rivalCompanyId, outboxId],
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("defaults detail to an empty object, not null", async () => {
    const rows = await db.query<{ detail: object }>(
      `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
       values ($1, $2, 'delivered', now()) returning detail`,
      [companyId, outboxId],
    );
    expect(rows.rows[0]?.detail).toEqual({});
  });

  it("is readable by the owning company but invisible to a rival", async () => {
    const own = await asUser<{ n: number }>(
      db,
      OWNER,
      `select count(*)::int n from public.email_delivery_events where email_outbox_id = $1`,
      [outboxId],
    );
    expect(own[0]?.n).toBeGreaterThan(0);

    const rival = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.email_delivery_events where email_outbox_id = $1`,
      [outboxId],
    );
    expect(rival[0]?.n).toBe(0);
  });
});
