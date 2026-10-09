import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * "Act as company" staff writes (20261009180000): when staff enter a customer's
 * console, the customer vendor and task flows write as the signed-in staff
 * member. Those write policies gate on can_write_company(), which a platform
 * admin never satisfies. The migration widens vendors_* and tasks_* with
 * `... or is_platform_admin()`, so a staff member who belongs to no company can
 * still insert/update/delete that company's vendors and tasks. A plain outsider
 * (neither member nor staff) must stay refused.
 */

const STAFF = "a1111111-1111-1111-1111-111111111111";
const OWNER = "b2222222-2222-2222-2222-222222222222";
const OUTSIDER = "d4444444-4444-4444-4444-444444444444";

let db: PGlite;
let companyId: string;

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
}, 60_000);

describe("vendors as acting staff", () => {
  it("lets a platform admin insert, update and delete a customer's vendor", async () => {
    const inserted = await asUser<{ id: string }>(
      db,
      STAFF,
      `insert into public.vendors (company_id, name, trade)
       values ($1, 'Bay Steel', 'Structural Steel') returning id`,
      [companyId],
    );
    const vendorId = inserted[0]!.id;

    await asUser(db, STAFF, `update public.vendors set name = 'Bay Steel Co' where id = $1`, [
      vendorId,
    ]);
    const renamed = await db.query<{ name: string }>(
      `select name from public.vendors where id = $1`,
      [vendorId],
    );
    expect(renamed.rows[0]?.name).toBe("Bay Steel Co");

    await asUser(db, STAFF, `delete from public.vendors where id = $1`, [vendorId]);
    const remaining = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendors where id = $1`,
      [vendorId],
    );
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it("still refuses a non-staff outsider inserting into the company", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        OUTSIDER,
        `insert into public.vendors (company_id, name, trade)
         values ($1, 'Rival Steel', 'Structural Steel')`,
        [companyId],
      ),
    );
  });
});

describe("tasks as acting staff", () => {
  it("lets a platform admin insert, update and delete a customer's task", async () => {
    const inserted = await asUser<{ id: string }>(
      db,
      STAFF,
      `insert into public.tasks (company_id, title) values ($1, 'Chase renewal') returning id`,
      [companyId],
    );
    const taskId = inserted[0]!.id;

    await asUser(db, STAFF, `update public.tasks set status = 'done' where id = $1`, [taskId]);
    const done = await db.query<{ status: string }>(
      `select status from public.tasks where id = $1`,
      [taskId],
    );
    expect(done.rows[0]?.status).toBe("done");

    await asUser(db, STAFF, `delete from public.tasks where id = $1`, [taskId]);
    const remaining = await db.query<{ n: number }>(
      `select count(*)::int n from public.tasks where id = $1`,
      [taskId],
    );
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it("still refuses a non-staff outsider inserting a task", async () => {
    await expectDeniedByRls(() =>
      asUser(db, OUTSIDER, `insert into public.tasks (company_id, title) values ($1, 'Sneak in')`, [
        companyId,
      ]),
    );
  });
});
