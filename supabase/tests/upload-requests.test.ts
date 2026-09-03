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

  it("lets a write-role member cancel an outstanding request they can write to", async () => {
    const created = await asUser<{ id: string }>(
      db,
      ALICE,
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'cancel-me-hash', now() + interval '14 days') returning id`,
      [alicesCompany, alicesVendor],
    );
    const requestId = created[0]!.id;

    const updated = await asUser<{ status: string }>(
      db,
      ALICE,
      `update public.vendor_upload_requests set status = 'cancelled' where id = $1 returning status`,
      [requestId],
    );
    expect(updated[0]?.status).toBe("cancelled");

    // The partial index this exercises has excluded 'cancelled' since
    // migration 4 (Phase 1) - dormant until now, since nothing ever set the
    // status to actually land a row outside it. Confirms it does.
    const stillOpen = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_upload_requests
       where id = $1 and expires_at > now()`,
      [requestId],
    );
    // Sanity: the row still exists and hasn't expired by date - only its
    // status moved it out of "open."
    expect(stillOpen.rows[0]?.n).toBe(1);

    const indexRows = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_upload_requests
       where id = $1 and status not in ('completed', 'expired', 'cancelled')`,
      [requestId],
    );
    expect(indexRows.rows[0]?.n).toBe(0);
  });

  it("refuses a rival company's owner cancelling it", async () => {
    const created = await asUser<{ id: string }>(
      db,
      ALICE,
      `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
       values ($1, $2, 'rival-cancel-hash', now() + interval '14 days') returning id`,
      [alicesCompany, alicesVendor],
    );
    const requestId = created[0]!.id;

    await asUser(
      db,
      BOB,
      `update public.vendor_upload_requests set status = 'cancelled' where id = $1`,
      [requestId],
    );

    // Not expectDeniedByRls(): can_write_company()'s USING clause simply
    // hides the row from BOB, so the UPDATE matches zero rows and succeeds
    // without error - the real assertion is that ALICE's row is untouched.
    const after = await db.query<{ status: string }>(
      `select status from public.vendor_upload_requests where id = $1`,
      [requestId],
    );
    expect(after.rows[0]?.status).toBe("pending");
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

  it("defaults malware_scan_status to not_configured, not null", async () => {
    const doc = await db.query<{ id: string }>(
      `insert into public.vendor_documents
         (company_id, vendor_id, upload_request_id, storage_path, file_name, mime_type, file_size, sha256)
       values ($1, $2, $3, 'company/x/vendor/y/documents/scan-default.pdf', 'coi.pdf', 'application/pdf', 100, repeat('c', 64))
       returning id`,
      [alicesCompany, alicesVendor, requestId],
    );
    const result = await db.query<{ malware_scan_status: string; scanned_at: string | null }>(
      `select malware_scan_status, scanned_at from public.vendor_documents where id = $1`,
      [doc.rows[0]!.id],
    );
    expect(result.rows[0]).toEqual({ malware_scan_status: "not_configured", scanned_at: null });
  });

  it("rejects a malware_scan_status outside the known set", async () => {
    await expect(
      db.query(
        `insert into public.vendor_documents
           (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256, malware_scan_status)
         values ($1, $2, 'company/x/vendor/y/documents/bad-scan-status.pdf', 'coi.pdf', 'application/pdf', 100, repeat('d', 64), 'infected')`,
        [alicesCompany, alicesVendor],
      ),
    ).rejects.toThrow();
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

  it.each(["document_received", "admin_review_needed"])(
    "accepts the %s template added in migration 9",
    async (template) => {
      const rows = await asUser<{ template: string }>(
        db,
        ALICE,
        `insert into public.email_outbox (company_id, vendor_id, template, to_email)
         values ($1, $2, $3, 'dana@corbettsteel.example') returning template`,
        [alicesCompany, alicesVendor, template],
      );
      expect(rows[0]?.template).toBe(template);
    },
  );

  it("accepts renewal_reminder, added in migration 10", async () => {
    const rows = await asUser<{ template: string }>(
      db,
      ALICE,
      `insert into public.email_outbox (company_id, vendor_id, template, to_email)
       values ($1, $2, 'renewal_reminder', 'dana@corbettsteel.example') returning template`,
      [alicesCompany, alicesVendor],
    );
    expect(rows[0]?.template).toBe("renewal_reminder");
  });

  it("still rejects a template outside the widened allow-list", async () => {
    await expect(
      asUser(
        db,
        ALICE,
        `insert into public.email_outbox (company_id, vendor_id, template, to_email)
         values ($1, $2, 'not_a_real_template', 'dana@corbettsteel.example')`,
        [alicesCompany, alicesVendor],
      ),
    ).rejects.toThrow();
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
