import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * Task 9a - document_extractions (the immutable, append-only extraction-
 * attempts table) and record_document_extraction() (the one function every
 * write site - Node's applyExtractionResult()/saveExtractionEdit() and both
 * Deno Edge Functions - calls to record an attempt).
 *
 * Two properties this task's own definition of done calls out as this
 * dispatch's to prove:
 *   - a reviewer's correction creates a NEW row and is attributable to them,
 *     never mutating or deleting the model's own row ("edits are
 *     attributable", "never overwrites model output");
 *   - a tri-state unknown (primary_noncontributory / endorsement_forms) that
 *     comes back null from a model attempt round-trips as null through
 *     record_document_extraction() and apply_policy_renewal() - it is never
 *     silently coerced to a compliant-looking value ("PNC/endorsement
 *     unknowns cannot auto-clear").
 */

const OWNER_A = "11111111-1111-1111-1111-111111111111";
const OWNER_B = "22222222-2222-2222-2222-222222222222";
const REVIEWER = "33333333-3333-3333-3333-333333333333";

let db: PGlite;
let companyA: string;
let companyB: string;
let vendorA: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, {
    id: OWNER_A,
    email: "owner-a@halstead.test",
    companyName: "Halstead Builders",
  });
  await signUp(db, { id: OWNER_B, email: "owner-b@other.test", companyName: "Other Co" });
  await signUp(db, { id: REVIEWER, email: "reviewer@vendorclr.test" });
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [REVIEWER]);

  companyA = await companyIdFor(db, OWNER_A);
  companyB = await companyIdFor(db, OWNER_B);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Structural Steel', 'Structural Steel')
     returning id`,
    [companyA],
  );
  vendorA = vendor.rows[0]!.id;
}, 60_000);

async function insertDocument(): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into public.vendor_documents (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256)
     values ($1, $2, $3, 'coi.pdf', 'application/pdf', 12345, $4)
     returning id`,
    [
      companyA,
      vendorA,
      `company/${companyA}/vendor/${vendorA}/documents/${crypto.randomUUID()}.pdf`,
      "d".repeat(64),
    ],
  );
  return result.rows[0]!.id;
}

const MODEL_PARSED = {
  document_type: "ACORD_25",
  policies: [
    {
      type: "general_liability",
      carrier: "Travelers",
      primary_noncontributory: null,
      endorsement_forms: null,
    },
  ],
  overall_confidence: 0.42,
};

describe("record_document_extraction()", () => {
  it("inserts an immutable model-sourced row and points vendor_documents at it", async () => {
    const documentId = await insertDocument();

    const result = await db.query<{ record_document_extraction: string }>(
      `select public.record_document_extraction(
         $1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', $3, $4::jsonb, null
       )`,
      [documentId, companyA, 0.42, JSON.stringify(MODEL_PARSED)],
    );
    const extractionId = result.rows[0]!.record_document_extraction;

    const doc = await db.query<{
      current_extraction_id: string;
      parsed_data: typeof MODEL_PARSED;
      extraction_confidence: string;
    }>(
      `select current_extraction_id, parsed_data, extraction_confidence from public.vendor_documents where id = $1`,
      [documentId],
    );
    expect(doc.rows[0]?.current_extraction_id).toBe(extractionId);
    expect(doc.rows[0]?.parsed_data).toEqual(MODEL_PARSED);
    expect(Number(doc.rows[0]?.extraction_confidence)).toBe(0.42);

    const extraction = await db.query<{
      source: string;
      reviewer_id: string | null;
      provider: string;
      model: string;
    }>(
      `select source, reviewer_id, provider, model from public.document_extractions where id = $1`,
      [extractionId],
    );
    expect(extraction.rows[0]).toEqual({
      source: "model",
      reviewer_id: null,
      provider: "anthropic",
      model: "claude-opus-5",
    });
  });

  it("keeps a tri-state null (primary_noncontributory/endorsement_forms) as null through the round trip - never auto-clears to a compliant-looking value", async () => {
    const documentId = await insertDocument();

    await db.query(
      `select public.record_document_extraction($1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', $3, $4::jsonb, null)`,
      [documentId, companyA, 0.9, JSON.stringify(MODEL_PARSED)],
    );

    const doc = await db.query<{ parsed_data: typeof MODEL_PARSED }>(
      `select parsed_data from public.vendor_documents where id = $1`,
      [documentId],
    );
    const policy = doc.rows[0]!.parsed_data.policies[0] as unknown as {
      primary_noncontributory: unknown;
      endorsement_forms: unknown;
    };
    // Still null, not coerced to false/true or an empty array - a broken
    // implementation that defaulted an absent/undeterminable value to
    // "false" or "[]" here would make a genuinely unknown endorsement look
    // like a confirmed negative, which is exactly the false-compliance bug
    // this schema's tri-state discipline exists to prevent.
    expect(policy.primary_noncontributory).toBeNull();
    expect(policy.endorsement_forms).toBeNull();
  });

  it("a reviewer_edit row creates a NEW row and never mutates the model row it supersedes", async () => {
    const documentId = await insertDocument();

    const modelResult = await db.query<{ record_document_extraction: string }>(
      `select public.record_document_extraction($1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', $3, $4::jsonb, null)`,
      [documentId, companyA, 0.5, JSON.stringify(MODEL_PARSED)],
    );
    const modelExtractionId = modelResult.rows[0]!.record_document_extraction;

    const correctedParsed = {
      ...MODEL_PARSED,
      policies: [{ ...MODEL_PARSED.policies[0], primary_noncontributory: true }],
    };

    const editResult = await db.query<{ record_document_extraction: string }>(
      `select public.record_document_extraction($1, $2, 'reviewer_edit', null, null, null, null, $3::jsonb, null, $4)`,
      [documentId, companyA, JSON.stringify(correctedParsed), REVIEWER],
    );
    const editExtractionId = editResult.rows[0]!.record_document_extraction;

    expect(editExtractionId).not.toBe(modelExtractionId);

    // The original model row is byte-for-byte untouched.
    const modelRow = await db.query<{ source: string; parsed_data: typeof MODEL_PARSED }>(
      `select source, parsed_data from public.document_extractions where id = $1`,
      [modelExtractionId],
    );
    expect(modelRow.rows[0]?.source).toBe("model");
    expect(modelRow.rows[0]?.parsed_data).toEqual(MODEL_PARSED);

    // The new row is attributable to the reviewer.
    const editRow = await db.query<{
      source: string;
      reviewer_id: string;
      confidence: string | null;
      parsed_data: typeof correctedParsed;
    }>(
      `select source, reviewer_id, confidence, parsed_data from public.document_extractions where id = $1`,
      [editExtractionId],
    );
    expect(editRow.rows[0]?.source).toBe("reviewer_edit");
    expect(editRow.rows[0]?.reviewer_id).toBe(REVIEWER);
    expect(editRow.rows[0]?.confidence).toBeNull();
    expect(editRow.rows[0]?.parsed_data).toEqual(correctedParsed);

    // vendor_documents now points at the edit, not the model row - but both
    // rows still exist and are independently queryable (the full audit
    // trail this task's definition of done calls for).
    const doc = await db.query<{
      current_extraction_id: string;
      parsed_data: typeof correctedParsed;
    }>(`select current_extraction_id, parsed_data from public.vendor_documents where id = $1`, [
      documentId,
    ]);
    expect(doc.rows[0]?.current_extraction_id).toBe(editExtractionId);
    expect(doc.rows[0]?.parsed_data).toEqual(correctedParsed);

    const history = await db.query<{ n: number }>(
      `select count(*)::int n from public.document_extractions where document_id = $1`,
      [documentId],
    );
    expect(history.rows[0]?.n).toBe(2);
  });

  it("rejects every UPDATE of an extraction row, even from a role that bypasses RLS (20260922140000)", async () => {
    const documentId = await insertDocument();
    const modelResult = await db.query<{ record_document_extraction: string }>(
      `select public.record_document_extraction($1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', $3, $4::jsonb, null)`,
      [documentId, companyA, 0.5, JSON.stringify(MODEL_PARSED)],
    );
    const modelExtractionId = modelResult.rows[0]!.record_document_extraction;

    // The test connection is a superuser - stricter than the service role.
    await expect(
      db.query(`update public.document_extractions set parsed_data = '{}'::jsonb where id = $1`, [
        modelExtractionId,
      ]),
    ).rejects.toThrow(/immutable/);

    const unchanged = await db.query<{ parsed_data: typeof MODEL_PARSED }>(
      `select parsed_data from public.document_extractions where id = $1`,
      [modelExtractionId],
    );
    expect(unchanged.rows[0]?.parsed_data).toEqual(MODEL_PARSED);

    // Deleting the document still cascades (customer deletion keeps working).
    await db.query(`delete from public.vendor_documents where id = $1`, [documentId]);
    const remaining = await db.query<{ n: number }>(
      `select count(*)::int n from public.document_extractions where document_id = $1`,
      [documentId],
    );
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it("rejects a reviewer_edit row with no reviewer_id, and a model row with one", async () => {
    const documentId = await insertDocument();
    await expect(
      db.query(
        `select public.record_document_extraction($1, $2, 'reviewer_edit', null, null, null, null, '{}'::jsonb, null, null)`,
        [documentId, companyA],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(
        `select public.record_document_extraction($1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', 0.5, '{}'::jsonb, null, $3)`,
        [documentId, companyA, REVIEWER],
      ),
    ).rejects.toThrow();
  });

  it("rejects an invalid source value", async () => {
    const documentId = await insertDocument();
    await expect(
      db.query(
        `select public.record_document_extraction($1, $2, 'bogus', null, null, null, null, '{}'::jsonb, null, null)`,
        [documentId, companyA],
      ),
    ).rejects.toThrow();
  });

  it("rejects a company_id that does not own the target document", async () => {
    const documentId = await insertDocument();
    await expect(
      db.query(
        `select public.record_document_extraction($1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', 0.5, '{}'::jsonb, null)`,
        [documentId, companyB],
      ),
    ).rejects.toThrow();
  });
});

describe("document_extractions RLS", () => {
  it("is readable by the owning company's members", async () => {
    const documentId = await insertDocument();
    const extraction = await db.query<{ record_document_extraction: string }>(
      `select public.record_document_extraction($1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', 0.5, '{}'::jsonb, null)`,
      [documentId, companyA],
    );

    const rows = await asUser(
      db,
      OWNER_A,
      `select id from public.document_extractions where id = $1`,
      [extraction.rows[0]!.record_document_extraction],
    );
    expect(rows).toHaveLength(1);
  });

  it("is invisible to a different company's members", async () => {
    const documentId = await insertDocument();
    const extraction = await db.query<{ record_document_extraction: string }>(
      `select public.record_document_extraction($1, $2, 'model', 'anthropic', 'claude-opus-5', 'v1', 0.5, '{}'::jsonb, null)`,
      [documentId, companyA],
    );

    const rows = await asUser(
      db,
      OWNER_B,
      `select id from public.document_extractions where id = $1`,
      [extraction.rows[0]!.record_document_extraction],
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot be inserted into directly by an authenticated company member - only record_document_extraction() (service role) writes it", async () => {
    const documentId = await insertDocument();
    await expectDeniedByRls(() =>
      asUser(
        db,
        OWNER_A,
        `insert into public.document_extractions (company_id, document_id, source, parsed_data)
         values ($1, $2, 'model', '{}'::jsonb)`,
        [companyA, documentId],
      ),
    );
  });
});

describe("apply_policy_renewal() primary_noncontributory", () => {
  it("stores a null primary_noncontributory as null, not a default false/true", async () => {
    const result = await db.query<{ apply_policy_renewal: string }>(
      `select public.apply_policy_renewal(
         $1, $2, null, 'general_liability', 'Travelers', 'GL-1',
         '2026-01-01', '2027-01-01', 2000000, 4000000, true, true,
         'Halstead Builders', null, null
       )`,
      [companyA, vendorA],
    );
    const policyId = result.rows[0]!.apply_policy_renewal;

    const row = await db.query<{ primary_noncontributory: boolean | null }>(
      `select primary_noncontributory from public.vendor_policies where id = $1`,
      [policyId],
    );
    expect(row.rows[0]?.primary_noncontributory).toBeNull();
  });

  it("stores an explicit primary_noncontributory value when the certificate determines one", async () => {
    // A distinct policy_type from the previous test - each vendor may only
    // have one ACTIVE policy per type (vendor_policies_one_active_per_type),
    // and this test's p_existing_policy_id is null (a fresh line, not a
    // renewal of the previous test's GL row).
    const result = await db.query<{ apply_policy_renewal: string }>(
      `select public.apply_policy_renewal(
         $1, $2, null, 'commercial_auto', 'Travelers', 'AUTO-1',
         '2026-01-01', '2027-01-01', 2000000, 4000000, true, true,
         'Halstead Builders', null, true
       )`,
      [companyA, vendorA],
    );
    const policyId = result.rows[0]!.apply_policy_renewal;

    const row = await db.query<{ primary_noncontributory: boolean | null }>(
      `select primary_noncontributory from public.vendor_policies where id = $1`,
      [policyId],
    );
    expect(row.rows[0]?.primary_noncontributory).toBe(true);
  });
});
