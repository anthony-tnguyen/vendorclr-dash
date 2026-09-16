import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * Task 8a - submission_packages / upload_request_checklist_items /
 * package_documents / document_processing_jobs, plus
 * vendor_documents.replaces_document_id (20260917000300_submission_packages.sql,
 * 20260917000400_document_processing_jobs.sql).
 *
 * The workflow functions themselves (createPackage/addPackageDocument/
 * finalizePackage/replaceDeficientDocument in
 * src/workflows/submissionPackages.ts) touch Supabase Storage and the
 * malware scanner - not exercisable here, same reason
 * uploadDocumentForToken() itself isn't (see upload-requests.test.ts's own
 * docblock). What this suite proves instead is the schema layer those
 * functions build on: the invariants a broken migration or a bug in those
 * functions could otherwise violate silently under RLS.
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let alicesCompany: string;
let bobsCompany: string;
let alicesVendor: string;
let alicesRequestId: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: ALICE, email: "alice@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, { id: BOB, email: "bob@rival.test", companyName: "Rival Construction" });
  alicesCompany = await companyIdFor(db, ALICE);
  bobsCompany = await companyIdFor(db, BOB);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Structural Steel', 'Structural Steel')
     returning id`,
    [alicesCompany],
  );
  alicesVendor = vendor.rows[0]!.id;

  const request = await db.query<{ id: string }>(
    `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
     values ($1, $2, 'submission-packages-hash', now() + interval '14 days') returning id`,
    [alicesCompany, alicesVendor],
  );
  alicesRequestId = request.rows[0]!.id;
}, 60_000);

describe("upload_request_checklist_items", () => {
  it("accepts a checklist line scoped to the owning company/vendor/request", async () => {
    const rows = await asUser<{ id: string; document_kind: string }>(
      db,
      ALICE,
      `insert into public.upload_request_checklist_items
         (company_id, vendor_id, upload_request_id, document_kind, is_required)
       values ($1, $2, $3, 'certificate_of_insurance', true)
       returning id, document_kind`,
      [alicesCompany, alicesVendor, alicesRequestId],
    );
    expect(rows[0]?.document_kind).toBe("certificate_of_insurance");
  });

  it("rejects an unrecognized document_kind", async () => {
    await expect(
      db.query(
        `insert into public.upload_request_checklist_items
           (company_id, vendor_id, upload_request_id, document_kind)
         values ($1, $2, $3, 'not_a_real_kind')`,
        [alicesCompany, alicesVendor, alicesRequestId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it("rejects a company_id that does not match the upload request's own company", async () => {
    await expect(
      db.query(
        `insert into public.upload_request_checklist_items
           (company_id, vendor_id, upload_request_id, document_kind)
         values ($1, $2, $3, 'additional_insured_endorsement')`,
        [bobsCompany, alicesVendor, alicesRequestId],
      ),
    ).rejects.toThrow(/company_id\/vendor_id do not match upload request/);
  });

  it("refuses a cross-tenant checklist insert under RLS", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        BOB,
        `insert into public.upload_request_checklist_items
           (company_id, vendor_id, upload_request_id, document_kind)
         values ($1, $2, $3, 'other')`,
        [alicesCompany, alicesVendor, alicesRequestId],
      ),
    );
  });
});

describe("submission_packages", () => {
  let packageId: string;

  it("opens version 1 as 'open' by default", async () => {
    const rows = await asUser<{ id: string; version: number; status: string }>(
      db,
      ALICE,
      `insert into public.submission_packages (company_id, vendor_id, upload_request_id)
       values ($1, $2, $3) returning id, version, status`,
      [alicesCompany, alicesVendor, alicesRequestId],
    );
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.status).toBe("open");
    packageId = rows[0]!.id;
  });

  it("refuses a second OPEN package for the same upload request", async () => {
    await expect(
      db.query(
        `insert into public.submission_packages (company_id, vendor_id, upload_request_id, version)
         values ($1, $2, $3, 2)`,
        [alicesCompany, alicesVendor, alicesRequestId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("allows a new version once the previous one is no longer open", async () => {
    await db.query(`update public.submission_packages set status = 'finalized' where id = $1`, [
      packageId,
    ]);

    const rows = await db.query<{ id: string; version: number }>(
      `insert into public.submission_packages
         (company_id, vendor_id, upload_request_id, version, status, previous_package_id, finalized_at)
       values ($1, $2, $3, 2, 'finalized', $4, now())
       returning id, version`,
      [alicesCompany, alicesVendor, alicesRequestId, packageId],
    );
    expect(rows.rows[0]?.version).toBe(2);

    await db.query(`update public.submission_packages set status = 'superseded' where id = $1`, [
      packageId,
    ]);
  });

  it("rejects a company_id that does not match the upload request", async () => {
    await expect(
      db.query(
        `insert into public.submission_packages (company_id, vendor_id, upload_request_id, version)
         values ($1, $2, $3, 3)`,
        [bobsCompany, alicesVendor, alicesRequestId],
      ),
    ).rejects.toThrow(/company_id\/vendor_id do not match upload request/);
  });

  it("refuses a cross-tenant package select under RLS", async () => {
    const rows = await asUser<{ id: string }>(
      db,
      BOB,
      `select id from public.submission_packages where upload_request_id = $1`,
      [alicesRequestId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("package_documents + vendor_documents replacement lineage", () => {
  let packageId: string;
  let originalDocumentId: string;
  let replacementDocumentId: string;

  beforeAll(async () => {
    const pkg = await db.query<{ id: string }>(
      `insert into public.submission_packages (company_id, vendor_id, upload_request_id, version, status)
       values ($1, $2, $3, 10, 'finalized') returning id`,
      [alicesCompany, alicesVendor, alicesRequestId],
    );
    packageId = pkg.rows[0]!.id;

    const doc = await db.query<{ id: string }>(
      `insert into public.vendor_documents
         (company_id, vendor_id, upload_request_id, storage_path, file_name, mime_type, file_size, sha256)
       values ($1, $2, $3, 'company/x/vendor/y/documents/original.pdf', 'coi.pdf', 'application/pdf', 12345, repeat('a', 64))
       returning id`,
      [alicesCompany, alicesVendor, alicesRequestId],
    );
    originalDocumentId = doc.rows[0]!.id;
  });

  it("links a document into a package under a document_kind", async () => {
    const rows = await asUser<{ id: string }>(
      db,
      ALICE,
      `insert into public.package_documents (company_id, vendor_id, package_id, document_id, document_kind)
       values ($1, $2, $3, $4, 'certificate_of_insurance') returning id`,
      [alicesCompany, alicesVendor, packageId, originalDocumentId],
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects linking a document that belongs to a different vendor/company", async () => {
    const otherVendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Other Vendor', 'Electrical') returning id`,
      [bobsCompany],
    );
    const otherDoc = await db.query<{ id: string }>(
      `insert into public.vendor_documents
         (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256)
       values ($1, $2, 'company/z/vendor/z/documents/other.pdf', 'other.pdf', 'application/pdf', 100, repeat('b', 64))
       returning id`,
      [bobsCompany, otherVendor.rows[0]!.id],
    );

    await expect(
      db.query(
        `insert into public.package_documents (company_id, vendor_id, package_id, document_id, document_kind)
         values ($1, $2, $3, $4, 'other')`,
        [alicesCompany, alicesVendor, packageId, otherDoc.rows[0]!.id],
      ),
    ).rejects.toThrow(/company_id\/vendor_id do not match document/);
  });

  it("records replacement lineage distinct from duplicate_of_document_id", async () => {
    const replacement = await db.query<{
      id: string;
      replaces_document_id: string | null;
      duplicate_of_document_id: string | null;
    }>(
      `insert into public.vendor_documents
         (company_id, vendor_id, upload_request_id, storage_path, file_name, mime_type, file_size, sha256, replaces_document_id)
       values ($1, $2, $3, 'company/x/vendor/y/documents/replacement.pdf', 'coi-corrected.pdf', 'application/pdf', 22222, repeat('c', 64), $4)
       returning id, replaces_document_id, duplicate_of_document_id`,
      [alicesCompany, alicesVendor, alicesRequestId, originalDocumentId],
    );
    replacementDocumentId = replacement.rows[0]!.id;
    expect(replacement.rows[0]?.replaces_document_id).toBe(originalDocumentId);
    expect(replacement.rows[0]?.duplicate_of_document_id).toBeNull();
  });

  it("links the replacement into a new package version alongside carried-over documents", async () => {
    const newPackage = await db.query<{ id: string }>(
      `insert into public.submission_packages
         (company_id, vendor_id, upload_request_id, version, status, previous_package_id, finalized_at)
       values ($1, $2, $3, 11, 'finalized', $4, now())
       returning id`,
      [alicesCompany, alicesVendor, alicesRequestId, packageId],
    );

    const rows = await asUser<{ document_id: string }>(
      db,
      ALICE,
      `insert into public.package_documents (company_id, vendor_id, package_id, document_id, document_kind)
       values ($1, $2, $3, $4, 'certificate_of_insurance') returning document_id`,
      [alicesCompany, alicesVendor, newPackage.rows[0]!.id, replacementDocumentId],
    );
    expect(rows[0]?.document_id).toBe(replacementDocumentId);
  });
});

describe("document_processing_jobs", () => {
  let documentId: string;

  beforeAll(async () => {
    const doc = await db.query<{ id: string }>(
      `insert into public.vendor_documents
         (company_id, vendor_id, upload_request_id, storage_path, file_name, mime_type, file_size, sha256)
       values ($1, $2, $3, 'company/x/vendor/y/documents/job-target.pdf', 'coi.pdf', 'application/pdf', 12345, repeat('d', 64))
       returning id`,
      [alicesCompany, alicesVendor, alicesRequestId],
    );
    documentId = doc.rows[0]!.id;
  });

  it("enqueues a job defaulting to 'queued' status", async () => {
    const rows = await db.query<{ id: string; status: string; job_type: string }>(
      `insert into public.document_processing_jobs
         (company_id, vendor_id, target_document_id, idempotency_key)
       values ($1, $2, $3, $4)
       returning id, status, job_type`,
      [alicesCompany, alicesVendor, documentId, `${documentId}:extract_document`],
    );
    expect(rows.rows[0]?.status).toBe("queued");
    expect(rows.rows[0]?.job_type).toBe("extract_document");
  });

  it("refuses a second job with the same idempotency_key - the enqueue-time half of duplicate-processing prevention", async () => {
    await expect(
      db.query(
        `insert into public.document_processing_jobs
           (company_id, vendor_id, target_document_id, idempotency_key)
         values ($1, $2, $3, $4)`,
        [alicesCompany, alicesVendor, documentId, `${documentId}:extract_document`],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("rejects a company_id/vendor_id that does not match the target document", async () => {
    await expect(
      db.query(
        `insert into public.document_processing_jobs
           (company_id, vendor_id, target_document_id, idempotency_key)
         values ($1, $2, $3, $4)`,
        [bobsCompany, alicesVendor, documentId, `${documentId}:extract_document:bad`],
      ),
    ).rejects.toThrow(/company_id\/vendor_id do not match target document/);
  });

  it("accepts 'exhausted' as a status value even though Task 8b's retry logic is not built yet", async () => {
    const rows = await db.query<{ status: string }>(
      `update public.document_processing_jobs set status = 'exhausted' where target_document_id = $1
       returning status`,
      [documentId],
    );
    expect(rows.rows[0]?.status).toBe("exhausted");
  });

  it("is visible to a company member via RLS select, but not to another tenant", async () => {
    const own = await asUser<{ id: string }>(
      db,
      ALICE,
      `select id from public.document_processing_jobs where target_document_id = $1`,
      [documentId],
    );
    expect(own.length).toBeGreaterThan(0);

    const other = await asUser<{ id: string }>(
      db,
      BOB,
      `select id from public.document_processing_jobs where target_document_id = $1`,
      [documentId],
    );
    expect(other).toHaveLength(0);
  });
});
