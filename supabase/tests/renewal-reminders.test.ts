import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * current_reminder_threshold() and policies_due_for_reminder - the detection
 * logic a scheduled job acts on. No pg_cron/pg_net dependency (see the
 * migration's docblock), so this is fully covered here; only the actual
 * scheduling and the Edge Function it calls are verified separately, against
 * the real hosted project.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const RIVAL_OWNER = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let companyId: string;

async function vendorWithGlPolicy(daysUntilExpiry: number | null): Promise<string> {
  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Test Vendor', 'Roofing')
     returning id`,
    [companyId],
  );
  const vid = vendor.rows[0]!.id;

  const expirationDate = daysUntilExpiry === null ? null : `current_date + ${daysUntilExpiry}`;
  await db.query(
    `insert into public.vendor_policies (company_id, vendor_id, policy_type, carrier_name, policy_number, expiration_date, status)
     values ($1, $2, 'general_liability', 'Travelers', 'GL-1', ${expirationDate ?? "null"}, 'active')`,
    [companyId, vid],
  );
  return vid;
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
  // RIVAL_OWNER's own company is never referenced by id - the RLS tests below
  // use RIVAL_OWNER's session directly (via asUser) rather than its company_id.
}, 60_000);

describe("current_reminder_threshold", () => {
  it.each([
    [95, null],
    [90, 90],
    [61, 90],
    [60, 60],
    [45, 60],
    [31, 60],
    [30, 30],
    [15, 30],
    [14, 14],
    [8, 14],
    [7, 7],
    [1, 7],
    [0, 7],
    [-1, null],
  ])("resolves %s days remaining to threshold %s", async (daysUntil, expected) => {
    const result = await db.query<{ threshold: number | null }>(
      `select current_reminder_threshold($1) as threshold`,
      [daysUntil],
    );
    expect(result.rows[0]?.threshold).toBe(expected);
  });
});

describe("policies_due_for_reminder", () => {
  it("surfaces a GL policy crossing a threshold for the first time", async () => {
    const vendorId = await vendorWithGlPolicy(45);
    const rows = await db.query<{ policy_id: string; days_threshold: number }>(
      `select policy_id, days_threshold from public.policies_due_for_reminder where vendor_id = $1`,
      [vendorId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.days_threshold).toBe(60);
  });

  it("does not surface a policy whose current threshold was already logged", async () => {
    const vid = await vendorWithGlPolicy(45);
    const policyRow = await db.query<{ id: string }>(
      `select id from public.vendor_policies where vendor_id = $1`,
      [vid],
    );
    await db.query(
      `insert into public.policy_reminder_log (company_id, vendor_id, policy_id, days_threshold)
       values ($1, $2, $3, 60)`,
      [companyId, vid, policyRow.rows[0]!.id],
    );

    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("surfaces the policy again once it crosses into the next, tighter threshold", async () => {
    // Same policy row as above (45 days, 60-day tier already logged); moving
    // the expiration to 25 days out crosses into the 30-day tier, which has
    // not been logged yet.
    const vid = await vendorWithGlPolicy(25);
    const rows = await db.query<{ days_threshold: number }>(
      `select days_threshold from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(rows.rows[0]?.days_threshold).toBe(30);
  });

  it("ignores an active policy more than 90 days from expiring", async () => {
    const vid = await vendorWithGlPolicy(120);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("ignores an already-expired policy", async () => {
    const vid = await vendorWithGlPolicy(-5);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("ignores a policy with no expiration date on file", async () => {
    const vid = await vendorWithGlPolicy(null);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("ignores a superseded policy even if its old expiration would otherwise be due", async () => {
    const vid = await vendorWithGlPolicy(5);
    await db.query(`update public.vendor_policies set status = 'superseded' where vendor_id = $1`, [
      vid,
    ]);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("ignores a non-general-liability policy - it does not drive the rail", async () => {
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'WC Only Vendor', 'Roofing')
       returning id`,
      [companyId],
    );
    await db.query(
      `insert into public.vendor_policies (company_id, vendor_id, policy_type, carrier_name, policy_number, expiration_date, status)
       values ($1, $2, 'workers_compensation', 'Hartford', 'WC-1', current_date + 10, 'active')`,
      [companyId, vendor.rows[0]!.id],
    );
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vendor.rows[0]!.id],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("is scoped to the caller's own company under RLS", async () => {
    const vid = await vendorWithGlPolicy(3);

    const own = await asUser<{ n: number }>(
      db,
      OWNER,
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(own[0]?.n).toBe(1);

    const rival = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.policies_due_for_reminder where vendor_id = $1`,
      [vid],
    );
    expect(rival[0]?.n).toBe(0);
  });
});

describe("policy_reminder_log", () => {
  it("refuses a second log entry for the same policy and threshold", async () => {
    const vid = await vendorWithGlPolicy(6);
    const policyRow = await db.query<{ id: string }>(
      `select id from public.vendor_policies where vendor_id = $1`,
      [vid],
    );
    const policyId = policyRow.rows[0]!.id;

    await db.query(
      `insert into public.policy_reminder_log (company_id, vendor_id, policy_id, days_threshold)
       values ($1, $2, $3, 7)`,
      [companyId, vid, policyId],
    );

    await expect(
      db.query(
        `insert into public.policy_reminder_log (company_id, vendor_id, policy_id, days_threshold)
         values ($1, $2, $3, 7)`,
        [companyId, vid, policyId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a threshold outside the five defined tiers", async () => {
    const vid = await vendorWithGlPolicy(6);
    const policyRow = await db.query<{ id: string }>(
      `select id from public.vendor_policies where vendor_id = $1`,
      [vid],
    );

    await expect(
      db.query(
        `insert into public.policy_reminder_log (company_id, vendor_id, policy_id, days_threshold)
         values ($1, $2, $3, 45)`,
        [companyId, vid, policyRow.rows[0]!.id],
      ),
    ).rejects.toThrow();
  });

  it("is readable by the owning company but invisible to another", async () => {
    const vid = await vendorWithGlPolicy(6);
    const policyRow = await db.query<{ id: string }>(
      `select id from public.vendor_policies where vendor_id = $1`,
      [vid],
    );
    await db.query(
      `insert into public.policy_reminder_log (company_id, vendor_id, policy_id, days_threshold)
       values ($1, $2, $3, 14)`,
      [companyId, vid, policyRow.rows[0]!.id],
    );

    const own = await asUser<{ n: number }>(
      db,
      OWNER,
      `select count(*)::int n from public.policy_reminder_log where vendor_id = $1`,
      [vid],
    );
    expect(own[0]?.n).toBeGreaterThan(0);

    const rival = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.policy_reminder_log where vendor_id = $1`,
      [vid],
    );
    expect(rival[0]?.n).toBe(0);
  });
});
