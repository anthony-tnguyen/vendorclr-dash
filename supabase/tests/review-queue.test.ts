import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { companyIdFor, createTestDb, signUp } from "./harness";

/**
 * Migration 12's additions to compliance_queue_items: document_id (the exact
 * link reprocessDocument() and the review screen rely on, replacing the
 * "most recent queue item for this vendor" approximation), and the
 * resolved/resolution/resolution_note/resolved_at shape documentReview.ts
 * writes when a reviewer acts. The one-time backfill UPDATE in the migration
 * itself has nothing to exercise here - createTestDb() applies every
 * migration in one pass against an empty database, so there is no
 * pre-migration-12 data for it to act on by the time any test runs; it was
 * verified separately against the live project (empty at the time, so a
 * no-op there too - see the PR description).
 */

const OWNER = "11111111-1111-1111-1111-111111111111";

let db: PGlite;
let companyId: string;
let vendorId: string;
let documentId: string;

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Review Test Vendor', 'Roofing')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;

  const doc = await db.query<{ id: string }>(
    `insert into public.vendor_documents (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256)
     values ($1, $2, 'company/x/vendor/y/documents/z.pdf', 'coi.pdf', 'application/pdf', 12345, repeat('a', 64))
     returning id`,
    [companyId, vendorId],
  );
  documentId = doc.rows[0]!.id;
}, 60_000);

describe("compliance_queue_items.document_id", () => {
  it("links a queue item to the exact document it was created for", async () => {
    const row = await db.query<{ document_id: string }>(
      `insert into public.compliance_queue_items (company_id, vendor_id, document_id, document_label)
       values ($1, $2, $3, 'Certificate of insurance') returning document_id`,
      [companyId, vendorId, documentId],
    );
    expect(row.rows[0]?.document_id).toBe(documentId);
  });

  it("sets document_id to null rather than erroring when its document is deleted", async () => {
    const doc = await db.query<{ id: string }>(
      `insert into public.vendor_documents (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256)
       values ($1, $2, 'company/x/vendor/y/documents/w.pdf', 'w.pdf', 'application/pdf', 1, repeat('b', 64))
       returning id`,
      [companyId, vendorId],
    );
    const queueItem = await db.query<{ id: string }>(
      `insert into public.compliance_queue_items (company_id, vendor_id, document_id, document_label)
       values ($1, $2, $3, 'Doomed doc') returning id`,
      [companyId, vendorId, doc.rows[0]!.id],
    );

    await db.query(`delete from public.vendor_documents where id = $1`, [doc.rows[0]!.id]);

    const after = await db.query<{ document_id: string | null }>(
      `select document_id from public.compliance_queue_items where id = $1`,
      [queueItem.rows[0]!.id],
    );
    expect(after.rows[0]?.document_id).toBeNull();
  });
});

describe("compliance_queue_items resolution", () => {
  it("defaults a fresh row to no resolution", async () => {
    const row = await db.query<{
      state: string;
      resolution: string | null;
      resolution_note: string;
      resolved_at: string | null;
    }>(
      `insert into public.compliance_queue_items (company_id, vendor_id, document_id, document_label)
       values ($1, $2, $3, 'Fresh item')
       returning state, resolution, resolution_note, resolved_at`,
      [companyId, vendorId, documentId],
    );
    expect(row.rows[0]).toEqual({
      state: "queued",
      resolution: null,
      resolution_note: "",
      resolved_at: null,
    });
  });

  it("accepts the new 'resolved' state with a matching resolution", async () => {
    const row = await db.query<{ state: string; resolution: string }>(
      `insert into public.compliance_queue_items
         (company_id, vendor_id, document_id, document_label, state, resolution, resolved_at)
       values ($1, $2, $3, 'Approved item', 'resolved', 'approved', now())
       returning state, resolution`,
      [companyId, vendorId, documentId],
    );
    expect(row.rows[0]).toEqual({ state: "resolved", resolution: "approved" });
  });

  it("rejects a resolved item with no resolution", async () => {
    await expect(
      db.query(
        `insert into public.compliance_queue_items
           (company_id, vendor_id, document_id, document_label, state, resolved_at)
         values ($1, $2, $3, 'Bad row', 'resolved', now())`,
        [companyId, vendorId, documentId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a non-resolved item that carries a resolution", async () => {
    await expect(
      db.query(
        `insert into public.compliance_queue_items
           (company_id, vendor_id, document_id, document_label, state, resolution)
         values ($1, $2, $3, 'Bad row', 'queued', 'approved')`,
        [companyId, vendorId, documentId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a resolution value outside approved/rejected", async () => {
    await expect(
      db.query(
        `insert into public.compliance_queue_items
           (company_id, vendor_id, document_id, document_label, state, resolution, resolved_at)
         values ($1, $2, $3, 'Bad row', 'resolved', 'ignored', now())`,
        [companyId, vendorId, documentId],
      ),
    ).rejects.toThrow();
  });
});
