import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { createTestDb } from "./harness";

/**
 * Managed-service outbound gate (20261001000200): a vendor_upload_requests row —
 * the row every outbound path creates — may only be inserted for a 'live'
 * workspace. A workspace still onboarding / in review cannot send to vendors yet.
 */

let db: PGlite;

async function makeCompany(serviceStatus: "onboarding" | "in_review" | "live"): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into public.companies (name, plan, activation_status, service_status)
     values ('Halstead Builders', 'core', 'activated', $1)
     returning id`,
    [serviceStatus],
  );
  return rows.rows[0]!.id;
}

async function makeVendor(companyId: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade)
     values ($1, 'Cascade Steel', 'Structural Steel')
     returning id`,
    [companyId],
  );
  return rows.rows[0]!.id;
}

async function insertRequest(companyId: string, vendorId: string, token: string): Promise<void> {
  await db.query(
    `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '7 days')`,
    [companyId, vendorId, token],
  );
}

describe("managed-service outbound gate (20261001000200)", () => {
  beforeEach(async () => {
    db = await createTestDb();
  });

  it("blocks a request for an onboarding workspace", async () => {
    const companyId = await makeCompany("onboarding");
    const vendorId = await makeVendor(companyId);
    await expect(insertRequest(companyId, vendorId, "tok-onboarding")).rejects.toThrow(
      /not live|held until launch/i,
    );
  });

  it("blocks a request for an in_review workspace", async () => {
    const companyId = await makeCompany("in_review");
    const vendorId = await makeVendor(companyId);
    await expect(insertRequest(companyId, vendorId, "tok-review")).rejects.toThrow(
      /not live|held until launch/i,
    );
  });

  it("allows a request once the workspace is live", async () => {
    const companyId = await makeCompany("live");
    const vendorId = await makeVendor(companyId);
    await insertRequest(companyId, vendorId, "tok-live");
    const rows = await db.query<{ n: string }>(
      `select count(*)::text as n from public.vendor_upload_requests where company_id = $1`,
      [companyId],
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });
});
