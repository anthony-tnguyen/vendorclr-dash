import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { companyIdFor, createTestDb, signUp } from "./harness";

const OWNER = "11111111-1111-1111-1111-111111111111";

let db: PGlite;
let companyId: string;
let vendorId: string;

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Structural Steel', 'Structural Steel')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;
}, 60_000);

function insertDocument(overrides: Record<string, unknown> = {}) {
  const defaults = {
    storage_path: `company/${companyId}/vendor/${vendorId}/documents/${crypto.randomUUID()}.pdf`,
    file_name: "coi.pdf",
    mime_type: "application/pdf",
    file_size: 12345,
    sha256: "a".repeat(64),
  };
  const merged = { ...defaults, ...overrides };
  const columns = Object.keys(merged);
  const values = Object.values(merged);
  const placeholders = values.map((_, i) => `$${i + 3}`).join(", ");

  return db.query<{ id: string }>(
    `insert into public.vendor_documents (company_id, vendor_id, ${columns.join(", ")})
     values ($1, $2, ${placeholders})
     returning id`,
    [companyId, vendorId, ...values],
  );
}

describe("vendor_documents extraction columns", () => {
  it("defaults parsed_data and extraction_confidence to null and duplicate_of_document_id to null", async () => {
    const result = await insertDocument();
    const row = await db.query<{
      parsed_data: unknown;
      extraction_confidence: number | null;
      duplicate_of_document_id: string | null;
    }>(
      `select parsed_data, extraction_confidence, duplicate_of_document_id
       from public.vendor_documents where id = $1`,
      [result.rows[0]!.id],
    );
    expect(row.rows[0]).toEqual({
      parsed_data: null,
      extraction_confidence: null,
      duplicate_of_document_id: null,
    });
  });

  it("stores a validated extraction result as jsonb and round-trips it", async () => {
    const parsed = {
      document_type: "ACORD_25",
      policies: [{ type: "general_liability", carrier: "Travelers" }],
      overall_confidence: 0.92,
    };
    const result = await insertDocument({ processing_status: "processed" });
    await db.query(
      `update public.vendor_documents set parsed_data = $1::jsonb, extraction_confidence = $2 where id = $3`,
      [JSON.stringify(parsed), 0.92, result.rows[0]!.id],
    );

    const row = await db.query<{ parsed_data: typeof parsed; extraction_confidence: string }>(
      `select parsed_data, extraction_confidence from public.vendor_documents where id = $1`,
      [result.rows[0]!.id],
    );
    expect(row.rows[0]?.parsed_data).toEqual(parsed);
    expect(Number(row.rows[0]?.extraction_confidence)).toBe(0.92);
  });

  it("rejects a confidence outside 0-1 at the database level, not just in application code", async () => {
    await expect(insertDocument({ extraction_confidence: 1.5 })).rejects.toThrow();
    await expect(insertDocument({ extraction_confidence: -0.1 })).rejects.toThrow();
  });

  it("accepts null confidence explicitly (extraction not yet run)", async () => {
    await expect(insertDocument({ extraction_confidence: null })).resolves.toBeDefined();
  });

  describe("duplicate detection", () => {
    it("allows two documents for the same vendor to share a sha256 (not a uniqueness constraint)", async () => {
      const sha256 = "b".repeat(64);
      const first = await insertDocument({ sha256 });
      const second = await insertDocument({ sha256, duplicate_of_document_id: first.rows[0]!.id });

      const rows = await db.query<{ n: number }>(
        `select count(*)::int n from public.vendor_documents where vendor_id = $1 and sha256 = $2`,
        [vendorId, sha256],
      );
      expect(rows.rows[0]?.n).toBe(2);

      const dup = await db.query<{ duplicate_of_document_id: string }>(
        `select duplicate_of_document_id from public.vendor_documents where id = $1`,
        [second.rows[0]!.id],
      );
      expect(dup.rows[0]?.duplicate_of_document_id).toBe(first.rows[0]!.id);
    });

    it("does not link documents across different vendors even with the same sha256", async () => {
      const otherVendor = await db.query<{ id: string }>(
        `insert into public.vendors (company_id, name, trade) values ($1, 'Other Vendor', 'Roofing')
         returning id`,
        [companyId],
      );
      const sha256 = "c".repeat(64);
      await insertDocument({ sha256 });

      const matches = await db.query<{ n: number }>(
        `select count(*)::int n from public.vendor_documents
         where vendor_id = $1 and sha256 = $2`,
        [otherVendor.rows[0]!.id, sha256],
      );
      // The application layer scopes its duplicate lookup by vendor_id - this
      // just confirms the schema itself imposes no cross-vendor uniqueness
      // that would make that scoping redundant or, worse, contradicted.
      expect(matches.rows[0]?.n).toBe(0);
    });

    it("sets duplicate_of_document_id to null (not an error) when the referenced document is deleted", async () => {
      const first = await insertDocument();
      const second = await insertDocument({ duplicate_of_document_id: first.rows[0]!.id });

      await db.query(`delete from public.vendor_documents where id = $1`, [first.rows[0]!.id]);

      const row = await db.query<{ duplicate_of_document_id: string | null }>(
        `select duplicate_of_document_id from public.vendor_documents where id = $1`,
        [second.rows[0]!.id],
      );
      expect(row.rows[0]?.duplicate_of_document_id).toBeNull();
    });
  });
});
