import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * Managed service: a VendorClr staff member runs a CSV vendor import on a
 * customer's behalf (20261010000100). import_vendor_row() already authorizes a
 * platform admin; this covers the one gap the migration closes - the
 * batch-summary row the import records at the end. vendor_import_batches_insert
 * is widened with `... or is_platform_admin()`, so staff can write it for a
 * company they are not a member of, while a plain outsider stays refused.
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

describe("staff vendor import on behalf", () => {
  it("lets a platform admin import a row and record the batch", async () => {
    const imported = await asUser<{ vendor_id: string; vendor_created: boolean }>(
      db,
      STAFF,
      `select * from public.import_vendor_row($1, 'Harbor Point', '', '', 'Bay Steel',
         'Structural Steel', 'Sam', 'sam@bay.test', 'moderate', 250000)`,
      [companyId],
    );
    expect(imported[0]?.vendor_created).toBe(true);

    // The batch summary insert is the row the widened policy unblocks.
    await asUser(
      db,
      STAFF,
      `insert into public.vendor_import_batches
         (company_id, idempotency_key, total_rows, accepted_rows, rejected_rows, row_results)
       values ($1, 'staff-batch-1', 1, 1, 0, '[]'::jsonb)`,
      [companyId],
    );
    const batch = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_import_batches where company_id = $1`,
      [companyId],
    );
    expect(batch.rows[0]?.n).toBe(1);
  });

  it("still refuses a non-staff outsider recording a batch", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        OUTSIDER,
        `insert into public.vendor_import_batches
           (company_id, idempotency_key, total_rows, accepted_rows, rejected_rows, row_results)
         values ($1, 'sneak-batch', 1, 1, 0, '[]'::jsonb)`,
        [companyId],
      ),
    );
  });
});
