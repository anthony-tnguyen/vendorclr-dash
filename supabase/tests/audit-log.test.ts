import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * audit_log (migration 14) and current_user_id(), the small helper that
 * makes attributing a service-role write to a real actor possible at all -
 * see assertPlatformAdmin()'s docblock in vendorUploadRequests.ts for why
 * resolveReviewItem()/reprocessDocument() need this and createUploadRequest()
 * doesn't (it writes on the request-scoped client, where actor_id's own
 * auth.uid() default already resolves correctly).
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const READER = "22222222-2222-2222-2222-222222222222";
const RIVAL_OWNER = "33333333-3333-3333-3333-333333333333";

let db: PGlite;
let companyId: string;
let vendorId: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, {
    id: RIVAL_OWNER,
    email: "owner@rival.test",
    companyName: "Rival Construction",
  });
  companyId = await companyIdFor(db, OWNER);

  await signUp(db, { id: READER, email: "reader@halstead.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only')`,
    [companyId, READER],
  );

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Audit Test Vendor', 'Roofing')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;
}, 60_000);

describe("current_user_id()", () => {
  it("returns the caller's own id", async () => {
    const rows = await asUser<{ id: string | null }>(db, OWNER, `select current_user_id() as id`);
    expect(rows[0]?.id).toBe(OWNER);
  });

  it("returns null for a caller with no JWT claims set (matches auth.uid() itself)", async () => {
    const result = await db.query<{ id: string | null }>(`select current_user_id() as id`);
    expect(result.rows[0]?.id).toBeNull();
  });
});

describe("audit_log", () => {
  it("defaults actor_id to the caller's own auth.uid() on the request-scoped client", async () => {
    const rows = await asUser<{ actor_id: string | null }>(
      db,
      OWNER,
      `insert into public.audit_log (company_id, action, target_type, target_id)
       values ($1, 'upload_request_created', 'vendor', $2) returning actor_id`,
      [companyId, vendorId],
    );
    expect(rows[0]?.actor_id).toBe(OWNER);
  });

  it("accepts an explicitly-passed actor_id, for service-role writes", async () => {
    const rows = await db.query<{ actor_id: string }>(
      `insert into public.audit_log (company_id, actor_id, action, target_type, target_id)
       values ($1, $2, 'review_resolved', 'compliance_queue_item', $3) returning actor_id`,
      [companyId, OWNER, vendorId],
    );
    expect(rows.rows[0]?.actor_id).toBe(OWNER);
  });

  it("rejects an action outside the known set", async () => {
    await expect(
      db.query(
        `insert into public.audit_log (company_id, action, target_type, target_id)
         values ($1, 'vendor_deleted', 'vendor', $2)`,
        [companyId, vendorId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a target_type outside the known set", async () => {
    await expect(
      db.query(
        `insert into public.audit_log (company_id, action, target_type, target_id)
         values ($1, 'upload_request_created', 'company', $2)`,
        [companyId, vendorId],
      ),
    ).rejects.toThrow();
  });

  it("refuses a read_only member writing", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `insert into public.audit_log (company_id, action, target_type, target_id)
         values ($1, 'upload_request_created', 'vendor', $2)`,
        [companyId, vendorId],
      ),
    );
  });

  it("is invisible to a different company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.audit_log where company_id = $1`,
      [companyId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("is readable by a write-role member of the owning company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      OWNER,
      `select count(*)::int n from public.audit_log where company_id = $1`,
      [companyId],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it("has no update policy - an owner's UPDATE matches zero rows, never amending one", async () => {
    // Not expectDeniedByRls(): with no UPDATE policy at all, RLS's USING
    // clause defaults to false, so the statement itself succeeds - it just
    // never sees a row to touch. The real assertion is that the row is
    // provably unchanged afterward, not that the UPDATE throws.
    const before = await db.query<{ detail: object }>(
      `select detail from public.audit_log where company_id = $1 limit 1`,
      [companyId],
    );
    await asUser(
      db,
      OWNER,
      `update public.audit_log set detail = '{"tampered":true}'::jsonb where company_id = $1`,
      [companyId],
    );
    const after = await db.query<{ detail: object }>(
      `select detail from public.audit_log where company_id = $1 limit 1`,
      [companyId],
    );
    expect(after.rows[0]?.detail).toEqual(before.rows[0]?.detail);
  });

  it("has no delete policy - an owner's DELETE removes nothing", async () => {
    const before = await db.query<{ n: number }>(
      `select count(*)::int n from public.audit_log where company_id = $1`,
      [companyId],
    );
    await asUser(db, OWNER, `delete from public.audit_log where company_id = $1`, [companyId]);
    const after = await db.query<{ n: number }>(
      `select count(*)::int n from public.audit_log where company_id = $1`,
      [companyId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
