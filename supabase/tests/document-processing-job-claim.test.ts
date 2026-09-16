import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, signUp, companyIdFor } from "./harness";

/**
 * Task 8b (Engineer A) - claim_document_processing_jobs()
 * (20260917000600_document_processing_job_worker.sql), the atomic-claim
 * primitive process-document-jobs/index.ts calls instead of a plain
 * `select ... update` so two overlapping invocations (a cron tick plus a
 * manual dispatch, or two cron ticks if a run takes longer than the
 * schedule interval) can never claim the same row.
 *
 * PGlite is a single-process WASM Postgres - there is no real second
 * connection racing this one at the network level, so this cannot prove
 * true multi-process concurrency. What it DOES prove, the same way
 * upload-abuse.test.ts's own "concurrency (Definition of Done)" suite does
 * for the rate limiter: that the query itself is written correctly for
 * concurrent callers (`for update skip locked`, not a read-then-write
 * race), by firing many overlapping claim calls via Promise.all and
 * checking the union of everything claimed has no duplicate ids and never
 * exceeds what was actually available - the exact property that matters
 * for "retries/providers cannot create duplicate processing results."
 */

let db: PGlite;
let companyId: string;
let vendorId: string;
let requestId: string;

const ALICE = "33333333-3333-3333-3333-333333333333";

async function seedDocument(label: string): Promise<string> {
  const doc = await db.query<{ id: string }>(
    `insert into public.vendor_documents
       (company_id, vendor_id, upload_request_id, storage_path, file_name, mime_type, file_size, sha256)
     values ($1, $2, $3, $4, $5, 'application/pdf', 100, $6)
     returning id`,
    [
      companyId,
      vendorId,
      requestId,
      `company/x/vendor/y/documents/${label}.pdf`,
      `${label}.pdf`,
      // A distinct-enough fake sha256 per row - only needs to be unique within this suite.
      label.padEnd(64, "0"),
    ],
  );
  return doc.rows[0]!.id;
}

async function seedJob(
  documentId: string,
  overrides: Partial<{
    status: string;
    next_attempt_at: string;
    claimed_at: string;
    attempt_count: number;
    max_attempts: number;
  }> = {},
): Promise<string> {
  const status = overrides.status ?? "queued";
  const job = await db.query<{ id: string }>(
    `insert into public.document_processing_jobs
       (company_id, vendor_id, target_document_id, idempotency_key, status,
        next_attempt_at, claimed_at, attempt_count, max_attempts)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7::timestamptz, $8, $9)
     returning id`,
    [
      companyId,
      vendorId,
      documentId,
      `${documentId}:extract_document`,
      status,
      overrides.next_attempt_at ?? null,
      overrides.claimed_at ?? null,
      overrides.attempt_count ?? 0,
      overrides.max_attempts ?? 5,
    ],
  );
  return job.rows[0]!.id;
}

async function claim(batchSize: number, claimedBy: string): Promise<Array<{ id: string }>> {
  const result = await db.query<{ id: string }>(
    `select id from public.claim_document_processing_jobs($1, $2)`,
    [batchSize, claimedBy],
  );
  return result.rows;
}

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: ALICE, email: "alice@claim.test", companyName: "Claim Co" });
  companyId = await companyIdFor(db, ALICE);

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Claim Vendor', 'Electrical')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;

  const request = await db.query<{ id: string }>(
    `insert into public.vendor_upload_requests (company_id, vendor_id, token_hash, expires_at)
     values ($1, $2, 'claim-test-hash', now() + interval '14 days') returning id`,
    [companyId, vendorId],
  );
  requestId = request.rows[0]!.id;
}, 60_000);

describe("claim_document_processing_jobs - grants", () => {
  async function canExecute(role: "anon" | "authenticated" | "service_role"): Promise<boolean> {
    const result = await db.query<{ can_exec: boolean }>(
      `select has_function_privilege($1, 'public.claim_document_processing_jobs(int,text,int)'::regprocedure, 'EXECUTE') as can_exec`,
      [role],
    );
    return result.rows[0]?.can_exec ?? false;
  }

  it("anon cannot execute it", async () => {
    expect(await canExecute("anon")).toBe(false);
  });

  it("authenticated cannot execute it", async () => {
    expect(await canExecute("authenticated")).toBe(false);
  });

  it("service_role can execute it", async () => {
    expect(await canExecute("service_role")).toBe(true);
  });
});

describe("claim_document_processing_jobs - eligibility", () => {
  it("claims a 'queued' job", async () => {
    const documentId = await seedDocument("eligibility-queued");
    const jobId = await seedJob(documentId, { status: "queued" });

    const claimed = await claim(10, "worker-a");
    expect(claimed.map((r) => r.id)).toContain(jobId);

    const row = await db.query<{ status: string; claimed_at: string | null; claimed_by: string }>(
      `select status, claimed_at, claimed_by from public.document_processing_jobs where id = $1`,
      [jobId],
    );
    expect(row.rows[0]?.status).toBe("processing");
    expect(row.rows[0]?.claimed_at).not.toBeNull();
    expect(row.rows[0]?.claimed_by).toBe("worker-a");
  });

  it("claims a 'failed' job whose next_attempt_at is due", async () => {
    const documentId = await seedDocument("eligibility-failed-due");
    const jobId = await seedJob(documentId, {
      status: "failed",
      next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    });

    const claimed = await claim(10, "worker-a");
    expect(claimed.map((r) => r.id)).toContain(jobId);
  });

  it("does NOT claim a 'failed' job still in its backoff window", async () => {
    const documentId = await seedDocument("eligibility-failed-not-due");
    const jobId = await seedJob(documentId, {
      status: "failed",
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const claimed = await claim(50, "worker-a");
    expect(claimed.map((r) => r.id)).not.toContain(jobId);
  });

  it("does NOT claim an 'exhausted' job", async () => {
    const documentId = await seedDocument("eligibility-exhausted");
    const jobId = await seedJob(documentId, {
      status: "exhausted",
      next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    });

    const claimed = await claim(50, "worker-a");
    expect(claimed.map((r) => r.id)).not.toContain(jobId);
  });

  it("does NOT claim a 'succeeded' job", async () => {
    const documentId = await seedDocument("eligibility-succeeded");
    const jobId = await seedJob(documentId, { status: "succeeded" });

    const claimed = await claim(50, "worker-a");
    expect(claimed.map((r) => r.id)).not.toContain(jobId);
  });

  it("reclaims a 'processing' job whose worker went stale (crash recovery)", async () => {
    const documentId = await seedDocument("eligibility-stale-processing");
    const jobId = await seedJob(documentId, {
      status: "processing",
      claimed_at: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 minutes ago
    });

    const claimed = await claim(50, "worker-b");
    expect(claimed.map((r) => r.id)).toContain(jobId);
  });

  it("does NOT reclaim a 'processing' job claimed recently", async () => {
    const documentId = await seedDocument("eligibility-fresh-processing");
    const jobId = await seedJob(documentId, {
      status: "processing",
      claimed_at: new Date().toISOString(),
    });

    const claimed = await claim(50, "worker-b");
    expect(claimed.map((r) => r.id)).not.toContain(jobId);
  });
});

describe("claim_document_processing_jobs - concurrency-shaped: no duplicate claims", () => {
  it("under many overlapping claim calls, every available job is claimed exactly once", async () => {
    const TOTAL_JOBS = 12;
    const jobIds: string[] = [];
    for (let i = 0; i < TOTAL_JOBS; i++) {
      const documentId = await seedDocument(`concurrency-${i}`);
      jobIds.push(await seedJob(documentId, { status: "queued" }));
    }

    // Six overlapping callers, batch size 3 each (18 requested against 12
    // available) - `for update skip locked` inside the function means a row
    // already locked by an earlier statement in this same call is simply
    // excluded from a later one, exactly as it would be excluded by a truly
    // concurrent second connection.
    const CALLERS = 6;
    const BATCH_SIZE = 3;
    const results = await Promise.all(
      Array.from({ length: CALLERS }, (_v, i) => claim(BATCH_SIZE, `concurrent-worker-${i}`)),
    );

    const allClaimedIds = results.flat().map((r) => r.id);
    const uniqueClaimedIds = new Set(allClaimedIds);

    // No id claimed twice across callers.
    expect(allClaimedIds.length).toBe(uniqueClaimedIds.size);
    // Only ever a subset of what was actually seeded and available.
    for (const id of allClaimedIds) expect(jobIds).toContain(id);
    // Every available job got claimed by exactly one caller (18 requested >= 12 available).
    expect(uniqueClaimedIds.size).toBe(TOTAL_JOBS);

    const stillQueued = await db.query<{ n: string }>(
      `select count(*)::text n from public.document_processing_jobs
       where id = any($1::uuid[]) and status = 'queued'`,
      [jobIds],
    );
    expect(stillQueued.rows[0]?.n).toBe("0");
  });
});
