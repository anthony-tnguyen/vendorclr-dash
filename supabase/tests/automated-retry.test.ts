import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * retry_count/next_retry_at and documents_due_for_retry (migration 17) - the
 * detection logic a scheduled job acts on. No pg_cron/pg_net dependency (see
 * the migration's docblock), so this is fully covered here; only the actual
 * scheduling and the Edge Function it calls are verified separately,
 * against the real hosted project.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const RIVAL_OWNER = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let companyId: string;
let vendorId: string;

async function insertDocument(overrides: {
  processingStatus?: string;
  retryCount?: number;
  nextRetryAt?: string | null;
}): Promise<string> {
  const { processingStatus = "failed", retryCount = 0, nextRetryAt = null } = overrides;

  const result = await db.query<{ id: string }>(
    `insert into public.vendor_documents
       (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256,
        processing_status, retry_count, next_retry_at)
     values ($1, $2, 'company/x/vendor/y/documents/' || gen_random_uuid() || '.pdf', 'coi.pdf',
             'application/pdf', 100, repeat('a', 64), $3, $4, $5)
     returning id`,
    [companyId, vendorId, processingStatus, retryCount, nextRetryAt],
  );
  return result.rows[0]!.id;
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

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Retry Test Vendor', 'Roofing')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;
}, 60_000);

describe("vendor_documents.retry_count / next_retry_at", () => {
  it("defaults to 0 and null", async () => {
    const id = await insertDocument({});
    const row = await db.query<{ retry_count: number; next_retry_at: string | null }>(
      `select retry_count, next_retry_at from public.vendor_documents where id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ retry_count: 0, next_retry_at: null });
  });

  it("rejects a negative retry_count", async () => {
    await expect(insertDocument({ retryCount: -1 })).rejects.toThrow();
  });
});

describe("documents_due_for_retry", () => {
  it("surfaces a failed document with no next_retry_at set", async () => {
    const id = await insertDocument({ processingStatus: "failed" });
    const rows = await db.query<{ document_id: string }>(
      `select document_id from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("surfaces a failed document whose next_retry_at has already passed", async () => {
    const id = await insertDocument({
      processingStatus: "failed",
      nextRetryAt: "2020-01-01T00:00:00Z",
    });
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("excludes a failed document whose next_retry_at is still in the future", async () => {
    const id = await insertDocument({
      processingStatus: "failed",
      nextRetryAt: "2099-01-01T00:00:00Z",
    });
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("excludes a document that has hit the retry_count cap, regardless of next_retry_at", async () => {
    const id = await insertDocument({
      processingStatus: "failed",
      retryCount: 5,
      nextRetryAt: "2020-01-01T00:00:00Z",
    });
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("still surfaces a document one attempt under the cap", async () => {
    const id = await insertDocument({ processingStatus: "failed", retryCount: 4 });
    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it.each(["uploaded", "processing", "processed", "needs_review"])(
    "ignores a document with processing_status %s, however retry_count/next_retry_at are set",
    async (status) => {
      const id = await insertDocument({ processingStatus: status });
      const rows = await db.query<{ n: number }>(
        `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
        [id],
      );
      expect(rows.rows[0]?.n).toBe(0);
    },
  );

  it("excludes a document whose linked queue item a human already resolved (e.g. rejected)", async () => {
    const id = await insertDocument({ processingStatus: "failed" });
    await db.query(
      `insert into public.compliance_queue_items
         (company_id, vendor_id, document_id, document_label, state, resolution, resolved_at)
       values ($1, $2, $3, 'Rejected doc', 'resolved', 'rejected', now())`,
      [companyId, vendorId, id],
    );

    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("still surfaces a document whose queue item is open (not yet resolved)", async () => {
    const id = await insertDocument({ processingStatus: "failed" });
    await db.query(
      `insert into public.compliance_queue_items
         (company_id, vendor_id, document_id, document_label, state)
       values ($1, $2, $3, 'Open doc', 'in-review')`,
      [companyId, vendorId, id],
    );

    const rows = await db.query<{ n: number }>(
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it("is scoped to the caller's own company under RLS", async () => {
    const id = await insertDocument({ processingStatus: "failed" });

    const own = await asUser<{ n: number }>(
      db,
      OWNER,
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(own[0]?.n).toBe(1);

    const rival = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.documents_due_for_retry where document_id = $1`,
      [id],
    );
    expect(rival[0]?.n).toBe(0);
  });
});
