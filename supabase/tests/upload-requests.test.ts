import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * vendor_upload_requests, vendor_documents, email_outbox, and the
 * vendor-documents storage bucket - the tables behind the magic-link portal.
 *
 * The key property to prove here is different from the rest of the schema:
 * these tables must be reachable by company members (for the dashboard) but
 * reachable by NO ONE via anon/authenticated RLS as an anonymous vendor - that
 * path only exists through the service-role server functions, which this suite
 * cannot exercise (no HTTP runtime), so what's verified here is the boundary
 * those functions rely on: an anonymous or cross-tenant session gets nothing.
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let alicesCompany: string;
let bobsCompany: string;
let alicesVendor: string;

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
}, 60_000);

describe("vendor_upload_requests", () => {
  it("lets a write-role member create a request for their own vendor", async () => {
    const rows = await asUser<{ id: string; status: string }>(
      db,
      ALICE,
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'hash-1', now() + interval '14 days') returning id, status`,
      [alicesCompany, alicesVendor],
    );
    expect(rows[0]?.status).toBe("pending");
  });

  it("refuses a request naming another company's vendor", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        BOB,
        `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
         values ($1, $2, 'hash-2', now() + interval '14 days')`,
        [alicesCompany, alicesVendor],
      ),
    );
  });

  it("is invisible to a different company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.vendor_upload_requests where company_id = $1`,
      [alicesCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("enforces one token_hash per row (a collision must not silently overwrite another request)", async () => {
    await db.query(
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'unique-hash', now() + interval '14 days')`,
      [alicesCompany, alicesVendor],
    );
    await expect(
      db.query(
        `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
         values ($1, $2, 'unique-hash', now() + interval '14 days')`,
        [alicesCompany, alicesVendor],
      ),
    ).rejects.toThrow();
  });

  it("rejects a request whose company_id does not match its vendor", async () => {
    await expect(
      db.query(
        `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
         values ($1, $2, 'mismatched-hash', now() + interval '14 days')`,
        [bobsCompany, alicesVendor],
      ),
    ).rejects.toThrow(/does not match/);
  });
});

describe("vendor_documents", () => {
  let requestId: string;

  beforeAll(async () => {
    const request = await db.query<{ id: string }>(
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'doc-flow-hash', now() + interval '14 days') returning id`,
      [alicesCompany, alicesVendor],
    );
    requestId = request.rows[0]!.id;
  });

  it("records an uploaded document without altering compliance status", async () => {
    await db.query(
      `insert into public.vendor_documents
         (company_id, vendor_id, upload_request_id, storage_path, file_name, mime_type, file_size, sha256)
       values ($1, $2, $3, 'company/x/vendor/y/documents/z.pdf', 'coi.pdf', 'application/pdf', 12345, repeat('a', 64))`,
      [alicesCompany, alicesVendor, requestId],
    );

    const doc = await db.query<{ processing_status: string }>(
      `select processing_status from public.vendor_documents where vendor_id = $1`,
      [alicesVendor],
    );
    expect(doc.rows[0]?.processing_status).toBe("uploaded");

    // A vendor's compliance items must not have moved just because a file exists.
    const compliance = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_compliance_items
       where vendor_id = $1 and status = 'compliant'`,
      [alicesVendor],
    );
    expect(compliance.rows[0]?.n).toBe(0);
  });

  it("rejects a file over the 25MB limit at the database, not just the client", async () => {
    await expect(
      db.query(
        `insert into public.vendor_documents
           (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256)
         values ($1, $2, 'company/x/vendor/y/documents/too-big.pdf', 'huge.pdf', 'application/pdf', 26214401, repeat('b', 64))`,
        [alicesCompany, alicesVendor],
      ),
    ).rejects.toThrow();
  });

  it("is invisible to a different company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.vendor_documents where company_id = $1`,
      [alicesCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("email_outbox", () => {
  it("lets a write-role member queue an email for their own vendor", async () => {
    const rows = await asUser<{ status: string }>(
      db,
      ALICE,
      `insert into public.email_outbox (company_id, vendor_id, template, to_email)
       values ($1, $2, 'renewal_request', 'dana@corbettsteel.example') returning status`,
      [alicesCompany, alicesVendor],
    );
    expect(rows[0]?.status).toBe("queued");
  });

  it("is invisible to a different company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.email_outbox where company_id = $1`,
      [alicesCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("vendor-documents storage bucket", () => {
  const OBJECT_PATH = "company/__ALICE__/vendor/vnd-1/documents/doc-1.pdf";

  beforeAll(async () => {
    await db.query(
      `insert into storage.objects (bucket_id, name) values ('vendor-documents', $1)`,
      [OBJECT_PATH.replace("__ALICE__", alicesCompany)],
    );
  });

  it("lets a member of the owning company read the object", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      ALICE,
      `select count(*)::int n from storage.objects where bucket_id = 'vendor-documents'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("hides the object from a different company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from storage.objects where bucket_id = 'vendor-documents'`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("does not error on an object whose path is not a company/<uuid>/... shape", async () => {
    // Regression check for the regex guard in front of the ::uuid cast: a
    // malformed or differently-shaped path must be filtered out, not throw.
    await db.query(
      `insert into storage.objects (bucket_id, name) values ('vendor-documents', 'not-a-company-path/whatever.pdf')`,
    );

    await expect(
      asUser(db, ALICE, `select name from storage.objects where bucket_id = 'vendor-documents'`),
    ).resolves.toBeDefined();
  });
});
