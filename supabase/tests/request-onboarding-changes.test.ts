import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, createTestDb } from "./harness";

/**
 * request_company_changes (20261001000300): staff send a submitted workspace back
 * to the customer — service_status in_review -> onboarding, submitted_at cleared —
 * so it drops out of the under-review state and into the editable wizard.
 */

const STAFF = "a1111111-1111-1111-1111-111111111111";
const OUTSIDER = "b2222222-2222-2222-2222-222222222222";

let db: PGlite;

async function makeUser(id: string, email: string): Promise<void> {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
}

async function makeStaff(id: string, email: string): Promise<void> {
  await makeUser(id, email);
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [id]);
}

async function makeCompany(opts: {
  serviceStatus: "onboarding" | "in_review" | "live";
  submitted: boolean;
}): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into public.companies (name, plan, activation_status, service_status)
     values ('Halstead Builders', 'core', 'activated', $1)
     returning id`,
    [opts.serviceStatus],
  );
  const companyId = rows.rows[0]!.id;
  await db.query(
    `insert into public.company_onboarding (company_id, current_step, submitted_at)
     values ($1, 6, $2)`,
    [companyId, opts.submitted ? new Date().toISOString() : null],
  );
  return companyId;
}

async function raiseMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

async function requestChanges(as: string, companyId: string): Promise<void> {
  await asUser(db, as, `select public.request_company_changes($1)`, [companyId]);
}

describe("request onboarding changes (20261001000300)", () => {
  beforeEach(async () => {
    db = await createTestDb();
    await makeStaff(STAFF, "ops@vendorclr.test");
  });

  it("sends a submitted company back to onboarding and clears submitted_at", async () => {
    const companyId = await makeCompany({ serviceStatus: "in_review", submitted: true });
    await requestChanges(STAFF, companyId);

    const company = await db.query<{ service_status: string }>(
      `select service_status from public.companies where id = $1`,
      [companyId],
    );
    expect(company.rows[0]?.service_status).toBe("onboarding");

    const onboarding = await db.query<{ submitted_at: string | null }>(
      `select submitted_at from public.company_onboarding where company_id = $1`,
      [companyId],
    );
    expect(onboarding.rows[0]?.submitted_at).toBeNull();
  });

  it("refuses a company that is not awaiting review", async () => {
    const companyId = await makeCompany({ serviceStatus: "onboarding", submitted: false });
    const message = await raiseMessage(() => requestChanges(STAFF, companyId));
    expect(message).toMatch(/awaiting review/i);
  });

  it("refuses a non-staff caller", async () => {
    await makeUser(OUTSIDER, "rosa@halstead.test");
    const companyId = await makeCompany({ serviceStatus: "in_review", submitted: true });
    const message = await raiseMessage(() => requestChanges(OUTSIDER, companyId));
    expect(message).toMatch(/not authorized/i);
  });
});
