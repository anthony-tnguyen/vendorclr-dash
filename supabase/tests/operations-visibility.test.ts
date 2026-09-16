import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * getOperationalFailures() (src/workflows/operations.ts) is staff-only,
 * cross-tenant-by-design data: it reads vendor_documents,
 * compliance_queue_items and email_delivery_events - the sources behind
 * "failed/exhausted extraction jobs," "stale review items" and "bounced/
 * complained email" - across every company, gated by assertPlatformAdmin()
 * (vendorUploadRequests.ts), which is nothing more than
 * `select is_platform_admin()` run through the request-scoped client. What
 * this file proves, against real Postgres RLS rather than a mocked
 * Supabase client, is exactly that gate's two failure modes:
 *
 *   1. A non-platform-admin cannot see another company's rows in any of
 *      the three source tables (the RLS boundary is real, not just
 *      trusted).
 *   2. A platform admin DOES see rows across every company in all three
 *      (the `or public.is_platform_admin()` clause each of their SELECT
 *      policies already carries actually works) - proving
 *      getOperationalFailures() is not accidentally scoped down to "just
 *      the caller's own company" the way an ordinary company-member query
 *      would be.
 *
 * getOperationalFailures() itself runs on the SERVICE ROLE (which bypasses
 * RLS entirely) after assertPlatformAdmin() already validated the caller via
 * exactly the is_platform_admin() RPC this file exercises - so proving (1)
 * and (2) here proves the gate this app's TypeScript actually calls, even
 * though the service-role reads that follow it are not themselves subject
 * to RLS. cron.job_run_details/pg_database_size() (the other two
 * operations signals) are read through public-schema wrapper functions
 * granted to service_role only (see
 * supabase/migrations/20260917000100_operations_cron_grants.sql and
 * 20260917000200_operations_scheduled_job_functions.sql) - not RLS-gated
 * tables, and not something PGlite can exercise at all (no `cron` schema -
 * see harness.ts's SKIPPED_IN_PGLITE), so they are out of scope for this
 * file; those were instead verified directly against the live project (see
 * this task's own report).
 */

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const STAFF = "44444444-4444-4444-4444-444444444444";

let db: PGlite;
let alicesCompany: string;
let bobsCompany: string;
let alicesVendorId: string;
let bobsVendorId: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: ALICE, email: "alice@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, { id: BOB, email: "bob@rival.test", companyName: "Rival Construction" });
  alicesCompany = await companyIdFor(db, ALICE);
  bobsCompany = await companyIdFor(db, BOB);

  await signUp(db, { id: STAFF, email: "staff@vendorclear.test" });
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [STAFF]);

  const alicesVendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Structural Steel', 'Structural Steel') returning id`,
    [alicesCompany],
  );
  alicesVendorId = alicesVendor.rows[0]!.id;

  const bobsVendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Rival Sub', 'Roofing') returning id`,
    [bobsCompany],
  );
  bobsVendorId = bobsVendor.rows[0]!.id;

  // A failed vendor_documents row per company - what "failed/exhausted
  // extraction jobs" reads.
  await db.query(
    `insert into public.vendor_documents
       (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256, processing_status, retry_count)
     values ($1, $2, 'company/a/doc-a.pdf', 'alice-cert.pdf', 'application/pdf', 1000, 'sha-alice', 'failed', 5)`,
    [alicesCompany, alicesVendorId],
  );
  await db.query(
    `insert into public.vendor_documents
       (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256, processing_status, retry_count)
     values ($1, $2, 'company/b/doc-b.pdf', 'bob-cert.pdf', 'application/pdf', 1000, 'sha-bob', 'failed', 1)`,
    [bobsCompany, bobsVendorId],
  );

  // A stale (submitted long ago, still open) compliance_queue_items row per
  // company - what "stale review items" reads.
  await db.query(
    `insert into public.compliance_queue_items (company_id, vendor_id, document_label, state, submitted_on)
     values ($1, $2, 'Alice stale review', 'in-review', current_date - interval '10 days')`,
    [alicesCompany, alicesVendorId],
  );
  await db.query(
    `insert into public.compliance_queue_items (company_id, vendor_id, document_label, state, submitted_on)
     values ($1, $2, 'Bob stale review', 'queued', current_date - interval '10 days')`,
    [bobsCompany, bobsVendorId],
  );

  // A bounced email_delivery_events row per company - what "bounced/
  // complained email" reads. Needs an email_outbox row to reference.
  const aliceOutbox = await db.query<{ id: string }>(
    `insert into public.email_outbox (company_id, vendor_id, template, to_email, status)
     values ($1, $2, 'renewal_request', 'vendor@alice-test.example', 'bounced') returning id`,
    [alicesCompany, alicesVendorId],
  );
  await db.query(
    `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
     values ($1, $2, 'bounced', now())`,
    [alicesCompany, aliceOutbox.rows[0]!.id],
  );

  const bobOutbox = await db.query<{ id: string }>(
    `insert into public.email_outbox (company_id, vendor_id, template, to_email, status)
     values ($1, $2, 'renewal_request', 'vendor@bob-test.example', 'bounced') returning id`,
    [bobsCompany, bobsVendorId],
  );
  await db.query(
    `insert into public.email_delivery_events (company_id, email_outbox_id, event_type, occurred_at)
     values ($1, $2, 'bounced', now())`,
    [bobsCompany, bobOutbox.rows[0]!.id],
  );

  // Task 8b - an exhausted document_processing_jobs row per company - what
  // evaluateExhaustedProcessingJobsAlert()'s data source reads. Needs a
  // vendor_documents row to target.
  const aliceDoc = await db.query<{ id: string }>(
    `insert into public.vendor_documents
       (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256)
     values ($1, $2, 'company/a/job-doc-a.pdf', 'alice-job.pdf', 'application/pdf', 1000, repeat('a', 64))
     returning id`,
    [alicesCompany, alicesVendorId],
  );
  await db.query(
    `insert into public.document_processing_jobs
       (company_id, vendor_id, target_document_id, idempotency_key, status)
     values ($1, $2, $3, $4, 'exhausted')`,
    [
      alicesCompany,
      alicesVendorId,
      aliceDoc.rows[0]!.id,
      `${aliceDoc.rows[0]!.id}:extract_document`,
    ],
  );

  const bobDoc = await db.query<{ id: string }>(
    `insert into public.vendor_documents
       (company_id, vendor_id, storage_path, file_name, mime_type, file_size, sha256)
     values ($1, $2, 'company/b/job-doc-b.pdf', 'bob-job.pdf', 'application/pdf', 1000, repeat('b', 64))
     returning id`,
    [bobsCompany, bobsVendorId],
  );
  await db.query(
    `insert into public.document_processing_jobs
       (company_id, vendor_id, target_document_id, idempotency_key, status)
     values ($1, $2, $3, $4, 'exhausted')`,
    [bobsCompany, bobsVendorId, bobDoc.rows[0]!.id, `${bobDoc.rows[0]!.id}:extract_document`],
  );
}, 60_000);

describe("assertPlatformAdmin()'s gate - is_platform_admin()", () => {
  it("is false for an ordinary company member", async () => {
    const rows = await asUser<{ is_admin: boolean }>(
      db,
      ALICE,
      `select public.is_platform_admin() as is_admin`,
    );
    expect(rows[0]?.is_admin).toBe(false);
  });

  it("is true for VendorClr staff", async () => {
    const rows = await asUser<{ is_admin: boolean }>(
      db,
      STAFF,
      `select public.is_platform_admin() as is_admin`,
    );
    expect(rows[0]?.is_admin).toBe(true);
  });
});

describe("vendor_documents (failed/exhausted extraction jobs)", () => {
  it("hides another company's failed documents from an ordinary member", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.vendor_documents where company_id = $1 and processing_status = 'failed'`,
      [alicesCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("shows a platform admin failed documents across every company", async () => {
    const rows = await asUser<{ company_id: string }>(
      db,
      STAFF,
      `select company_id from public.vendor_documents where processing_status = 'failed' order by company_id`,
    );
    const companyIds = new Set(rows.map((r) => r.company_id));
    expect(companyIds.has(alicesCompany)).toBe(true);
    expect(companyIds.has(bobsCompany)).toBe(true);
  });
});

describe("compliance_queue_items (stale review items)", () => {
  it("hides another company's open queue items from an ordinary member", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      ALICE,
      `select count(*)::int n from public.compliance_queue_items where company_id = $1 and state != 'resolved'`,
      [bobsCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("shows a platform admin open queue items across every company", async () => {
    const rows = await asUser<{ company_id: string }>(
      db,
      STAFF,
      `select company_id from public.compliance_queue_items where state != 'resolved' order by company_id`,
    );
    const companyIds = new Set(rows.map((r) => r.company_id));
    expect(companyIds.has(alicesCompany)).toBe(true);
    expect(companyIds.has(bobsCompany)).toBe(true);
  });

  it("keeps writes staff-only: an ordinary member's UPDATE matches zero rows, never amending one", async () => {
    // Not expectDeniedByRls(): compliance_queue_items_write's USING clause
    // is is_platform_admin() only, no company-membership OR clause - so for
    // a non-admin the statement itself succeeds, it just never sees a row
    // to touch. The real assertion is that the row is provably unchanged
    // afterward, not that the UPDATE throws.
    const before = await db.query<{ state: string }>(
      `select state from public.compliance_queue_items where company_id = $1 and document_label = 'Alice stale review'`,
      [alicesCompany],
    );
    await asUser(
      db,
      ALICE,
      `update public.compliance_queue_items set state = 'escalated' where company_id = $1`,
      [alicesCompany],
    );
    const after = await db.query<{ state: string }>(
      `select state from public.compliance_queue_items where company_id = $1 and document_label = 'Alice stale review'`,
      [alicesCompany],
    );
    expect(after.rows[0]?.state).toBe(before.rows[0]?.state);
  });
});

describe("email_delivery_events (bounced/complained email)", () => {
  it("hides another company's bounce events from an ordinary member", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.email_delivery_events where company_id = $1 and event_type = 'bounced'`,
      [alicesCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("shows a platform admin bounce events across every company", async () => {
    const rows = await asUser<{ company_id: string }>(
      db,
      STAFF,
      `select company_id from public.email_delivery_events where event_type = 'bounced' order by company_id`,
    );
    const companyIds = new Set(rows.map((r) => r.company_id));
    expect(companyIds.has(alicesCompany)).toBe(true);
    expect(companyIds.has(bobsCompany)).toBe(true);
  });
});

describe("document_processing_jobs (Task 8b - exhausted processing jobs)", () => {
  it("hides another company's exhausted jobs from an ordinary member", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      BOB,
      `select count(*)::int n from public.document_processing_jobs where company_id = $1 and status = 'exhausted'`,
      [alicesCompany],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("shows a platform admin exhausted jobs across every company", async () => {
    const rows = await asUser<{ company_id: string }>(
      db,
      STAFF,
      `select company_id from public.document_processing_jobs where status = 'exhausted' order by company_id`,
    );
    const companyIds = new Set(rows.map((r) => r.company_id));
    expect(companyIds.has(alicesCompany)).toBe(true);
    expect(companyIds.has(bobsCompany)).toBe(true);
  });
});
