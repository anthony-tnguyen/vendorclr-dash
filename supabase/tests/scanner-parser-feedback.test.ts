import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./harness";

const vendorclearRoot = process.env["VENDORCLEAR_REPO_DIR"]
  ? resolve(process.env["VENDORCLEAR_REPO_DIR"]!)
  : null;
const suite = vendorclearRoot ? describe : describe.skip;

suite("public scanner parser provenance and feedback", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createTestDb();
    for (const file of [
      "20261002073110_coi_scanner_lead_tables.sql",
      "20261003032658_scanner_parser_provenance_feedback.sql",
    ]) {
      await db.exec(readFileSync(join(vendorclearRoot!, "supabase", "migrations", file), "utf8"));
    }
  }, 120_000);

  afterAll(async () => db?.close());

  it("creates private provenance, lineage, and pending-feedback structures", async () => {
    const columns = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema='public' and table_name='scanner_reports'
    `);
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "root_report_id",
        "report_sequence",
        "parser_run_id",
        "parser_metadata",
      ]),
    );
    const bucket = await db.query<{ public: boolean }>(
      `select public from storage.buckets where id='scanner-parser-feedback'`,
    );
    expect(bucket.rows).toEqual([{ public: false }]);
  });

  it("does not grant anon direct feedback reads, inserts, or verification updates", async () => {
    for (const sql of [
      "select * from public.scanner_parser_feedback",
      "insert into public.scanner_parser_feedback (parser_run_id,response,original_extraction,parser_metadata) values (gen_random_uuid(),'looks_correct','{}','{}')",
      "update public.scanner_parser_feedback set verified_status='verified'",
    ]) {
      await db.exec("begin");
      await db.exec("set local role anon");
      await expect(db.query(sql)).rejects.toThrow(/permission denied/i);
      await db.exec("rollback");
    }
  });
});
