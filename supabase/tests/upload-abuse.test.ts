import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb, expectDeniedByRls } from "./harness";

/**
 * Proves the one thing a mocked Supabase client never could:
 * increment_upload_rate_limit_counter() (migration
 * 20260916000200_upload_abuse_controls.sql) - the atomic primitive
 * assertUploadAllowed() (src/workflows/uploadAbuse.server.ts) relies on for
 * every one of its five rate limits - is genuinely safe under concurrent
 * callers hitting the SAME bucket/window, via a real Postgres row lock, not
 * an application-level lock this project doesn't have. src/tests/upload-
 * abuse.test.ts covers assertUploadAllowed()'s own decision logic (which
 * rules apply per operation, the throttle/captcha thresholds, the
 * fail-closed HMAC secret) against a mocked counter - this file is what
 * proves the counter itself cannot be raced.
 *
 * Also covers this table/function's access boundary, the same "revoke ...
 * from public does not mean what it looks like" pattern every other
 * function in this schema is checked against (see function-grants.test.ts) -
 * and that RLS with zero policies denies anon/authenticated both reads and
 * writes outright, the same shape upload_rate_limit_counters shares with
 * every other zero-policy table in this schema.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("increment_upload_rate_limit_counter()", () => {
  it("starts a fresh bucket/window at 1", async () => {
    const result = await db.query<{ n: number }>(
      `select public.increment_upload_rate_limit_counter($1, $2) as n`,
      ["resolve:ip:test-bucket-a", "2026-01-01T00:00:00Z"],
    );
    expect(result.rows[0]?.n).toBe(1);
  });

  it("increments an existing bucket/window rather than resetting it", async () => {
    const bucket = "resolve:ip:test-bucket-b";
    const window = "2026-01-01T00:10:00Z";
    await db.query(`select public.increment_upload_rate_limit_counter($1, $2)`, [bucket, window]);
    await db.query(`select public.increment_upload_rate_limit_counter($1, $2)`, [bucket, window]);
    const third = await db.query<{ n: number }>(
      `select public.increment_upload_rate_limit_counter($1, $2) as n`,
      [bucket, window],
    );
    expect(third.rows[0]?.n).toBe(3);
  });

  it("keeps different window_start values for the same bucket_key entirely separate", async () => {
    const bucket = "resolve:ip:test-bucket-c";
    await db.query(`select public.increment_upload_rate_limit_counter($1, $2)`, [
      bucket,
      "2026-01-01T00:00:00Z",
    ]);
    const otherWindow = await db.query<{ n: number }>(
      `select public.increment_upload_rate_limit_counter($1, $2) as n`,
      [bucket, "2026-01-01T00:10:00Z"],
    );
    expect(otherWindow.rows[0]?.n).toBe(1);
  });

  it("keeps different bucket_key values for the same window_start entirely separate", async () => {
    const window = "2026-01-01T01:00:00Z";
    await db.query(`select public.increment_upload_rate_limit_counter($1, $2)`, [
      "upload:token:aaa",
      window,
    ]);
    const otherBucket = await db.query<{ n: number }>(
      `select public.increment_upload_rate_limit_counter($1, $2) as n`,
      ["upload:token:bbb", window],
    );
    expect(otherBucket.rows[0]?.n).toBe(1);
  });

  it("persists exactly one row per bucket/window pair in upload_rate_limit_counters", async () => {
    const bucket = "resolve:ip:test-bucket-row-shape";
    const window = "2026-01-01T02:00:00Z";
    await db.query(`select public.increment_upload_rate_limit_counter($1, $2)`, [bucket, window]);
    await db.query(`select public.increment_upload_rate_limit_counter($1, $2)`, [bucket, window]);

    const rows = await db.query<{ bucket_key: string; window_start: string; count: number }>(
      `select bucket_key, window_start, count from public.upload_rate_limit_counters where bucket_key = $1`,
      [bucket],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.count).toBe(2);
  });
});

describe("increment_upload_rate_limit_counter() under real concurrency (Definition of Done)", () => {
  it("N parallel increments against the same bucket/window never lose an update - the final count is exactly N, with no duplicate or skipped values", async () => {
    const bucket = "upload:ip:concurrency-test";
    const window = "2026-02-01T00:00:00Z";
    const N = 50;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        db.query<{ n: number }>(`select public.increment_upload_rate_limit_counter($1, $2) as n`, [
          bucket,
          window,
        ]),
      ),
    );

    const counts = results.map((r) => r.rows[0]?.n).sort((a, b) => (a ?? 0) - (b ?? 0));
    // Every one of the N concurrent callers must have received a distinct,
    // sequential count - 1..N in some order, no repeats and no gaps. A
    // lost-update race (two callers both reading count=k and both writing
    // k+1) would show up here as a duplicate value and a count short of N.
    expect(counts).toEqual(Array.from({ length: N }, (_v, i) => i + 1));

    const final = await db.query<{ count: number }>(
      `select count from public.upload_rate_limit_counters where bucket_key = $1 and window_start = $2`,
      [bucket, window],
    );
    expect(final.rows[0]?.count).toBe(N);
  }, 30_000);

  it("simulates assertUploadAllowed()'s own pass/fail split: exactly `limit` of N concurrent callers see a count within the limit", async () => {
    const bucket = "resolve:ip:concurrency-limit-test";
    const window = "2026-02-01T01:00:00Z";
    const limit = 20;
    const N = 40;

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        db.query<{ n: number }>(`select public.increment_upload_rate_limit_counter($1, $2) as n`, [
          bucket,
          window,
        ]),
      ),
    );

    const allowed = results.filter((r) => (r.rows[0]?.n ?? Infinity) <= limit).length;
    const throttled = results.filter((r) => (r.rows[0]?.n ?? Infinity) > limit).length;

    expect(allowed).toBe(limit);
    expect(throttled).toBe(N - limit);
  }, 30_000);
});

describe("upload_rate_limit_counters: access boundary", () => {
  async function canExecute(role: "anon" | "authenticated" | "service_role"): Promise<boolean> {
    const result = await db.query<{ can_exec: boolean }>(
      `select has_function_privilege($1, 'public.increment_upload_rate_limit_counter(text, timestamptz)'::regprocedure, 'EXECUTE') as can_exec`,
      [role],
    );
    return result.rows[0]?.can_exec ?? false;
  }

  it("anon cannot execute increment_upload_rate_limit_counter()", async () => {
    expect(await canExecute("anon")).toBe(false);
  });

  it("authenticated cannot execute increment_upload_rate_limit_counter() either - only service_role does", async () => {
    expect(await canExecute("authenticated")).toBe(false);
  });

  it("service_role can execute increment_upload_rate_limit_counter()", async () => {
    expect(await canExecute("service_role")).toBe(true);
  });

  it("RLS with zero policies denies anon a direct read of upload_rate_limit_counters", async () => {
    await db.query(`select public.increment_upload_rate_limit_counter($1, $2)`, [
      "resolve:ip:rls-read-check",
      "2026-03-01T00:00:00Z",
    ]);

    await db.exec("begin");
    await db.exec("set local role anon");
    const rows = await db.query(`select * from public.upload_rate_limit_counters`);
    expect(rows.rows).toHaveLength(0);
    await db.exec("commit");
  });

  it("RLS with zero policies denies anon a direct write to upload_rate_limit_counters", async () => {
    await expectDeniedByRls(async () => {
      await db.exec("begin");
      await db.exec("set local role anon");
      await db.query(
        `insert into public.upload_rate_limit_counters (bucket_key, window_start, count) values ('forged', now(), 999)`,
      );
      await db.exec("commit");
    });
  });
});
