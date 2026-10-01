import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, createTestDb } from "./harness";

/**
 * Launch-readiness guard on set_company_service_status (20261001000100).
 *
 * A workspace may only be moved to 'live' once the customer has finished the
 * wizard: service_status 'in_review' with a submitted onboarding row. Before the
 * guard, staff (or a replayed request) could launch a company still filling in
 * the wizard, opening a half-configured workspace — the P0.
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

/** Creates a company + onboarding row directly (superuser), bypassing the wizard. */
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

async function launch(as: string, companyId: string): Promise<void> {
  await asUser(db, as, `select public.set_company_service_status($1, 'live')`, [companyId]);
}

describe("onboarding launch guard (20261001000100)", () => {
  beforeEach(async () => {
    db = await createTestDb();
    await makeStaff(STAFF, "ops@vendorclr.test");
  });

  it("refuses to launch a company still in onboarding", async () => {
    const companyId = await makeCompany({ serviceStatus: "onboarding", submitted: false });
    const message = await raiseMessage(() => launch(STAFF, companyId));
    expect(message).toMatch(/not ready to launch/i);
  });

  it("refuses to launch an in_review company with no submitted_at", async () => {
    const companyId = await makeCompany({ serviceStatus: "in_review", submitted: false });
    const message = await raiseMessage(() => launch(STAFF, companyId));
    expect(message).toMatch(/not ready to launch/i);
  });

  it("launches a submitted, in_review company", async () => {
    const companyId = await makeCompany({ serviceStatus: "in_review", submitted: true });
    await launch(STAFF, companyId);
    const rows = await db.query<{ service_status: string }>(
      `select service_status from public.companies where id = $1`,
      [companyId],
    );
    expect(rows.rows[0]?.service_status).toBe("live");
  });

  it("still refuses a non-staff caller", async () => {
    await makeUser(OUTSIDER, "rosa@halstead.test");
    const companyId = await makeCompany({ serviceStatus: "in_review", submitted: true });
    const message = await raiseMessage(() => launch(OUTSIDER, companyId));
    expect(message).toMatch(/not authorized/i);
  });
});
