#!/usr/bin/env bun
/**
 * Review-queue correction -> golden case capture.
 *
 * Standalone operations script, same conventions as export-company.ts: run by
 * hand, never imported by src/**, never scheduled, Node/Bun APIs are fine
 * (never in the Cloudflare Workers request path). Uses the shared
 * service-role admin client (getAdminClient) and reads a LIVE project.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Every time a human corrects a parse on the review screen, Task 9a records an
 * immutable document_extractions row with source = 'reviewer_edit' whose
 * parsed_data is the WHOLE corrected InsuranceExtraction - i.e. verified
 * ground truth for a real, hard certificate, with the right answer already
 * attached. That is the single best source of golden cases there is, and it
 * grows on its own wherever the parser is weakest. This script harvests those
 * corrections into the eval's golden-set format so the flywheel
 * (production correction -> eval case -> tuning -> fewer corrections) actually
 * turns instead of being manual copy-paste.
 *
 * For each reviewer_edit (latest per document), it writes:
 *   <out>/<case-id>/document.<ext>   the source certificate (from storage)
 *   <out>/<case-id>/expected.json    the human-corrected extraction
 *   <out>/<case-id>/provenance.json  ids / reviewer / timestamp, for audit
 *
 * ---------------------------------------------------------------------------
 * PRIVACY: it stages, it does not commit
 * ---------------------------------------------------------------------------
 * These are REAL customer certificates (insured names, addresses, policy
 * numbers). The default output dir `evals/coi-extraction/captured/` is
 * GIT-IGNORED. Nothing lands in the committed `cases/` set automatically. A
 * human reviews each captured case, confirms the correction is actually
 * correct, redacts or clears anything that shouldn't be retained, and only
 * then moves the good ones into `cases/`. Do not short-circuit that step.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   VENDORCLEAR_SUPABASE_URL=... VENDORCLEAR_SERVICE_ROLE_KEY=... \
 *     bun run capture:golden
 *   ... bun scripts/capture-golden-cases.ts --since=2026-09-01 --limit=100
 *   ... bun scripts/capture-golden-cases.ts --company=<uuid> --out=some/dir
 *   ... bun scripts/capture-golden-cases.ts --force   # overwrite existing
 *
 * Flags:
 *   --since=<ISO date>  only corrections at/after this date (e.g. 2026-09-01)
 *   --limit=<n>         cap corrections fetched (default 200)
 *   --company=<uuid>    only this company
 *   --out=<dir>         output dir (default evals/coi-extraction/captured)
 *   --force             re-capture a case whose dir already exists
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { SupabaseClient } from "@supabase/supabase-js";

import { VENDOR_DOCUMENTS_BUCKET } from "./lib/companyScopedTables";
import { getAdminClient } from "./lib/supabaseAdminClient";
import {
  InsuranceExtractionSchema,
  normalizeExtraction,
} from "../src/workflows/insuranceExtractionSchema";

const DEFAULT_OUT = "evals/coi-extraction/captured";
const DEFAULT_LIMIT = 200;

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
};

interface ReviewerEditRow {
  id: string;
  company_id: string;
  document_id: string;
  parsed_data: unknown;
  confidence: number | null;
  reviewer_id: string | null;
  attempted_at: string;
}

interface DocumentRow {
  storage_path: string;
  mime_type: string;
  file_name: string;
}

interface Args {
  since: string | null;
  limit: number;
  company: string | null;
  out: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { since: null, limit: DEFAULT_LIMIT, company: null, out: DEFAULT_OUT, force: false };
  for (const arg of argv) {
    if (arg.startsWith("--since=")) a.since = arg.slice("--since=".length);
    else if (arg.startsWith("--limit=")) a.limit = Number.parseInt(arg.slice("--limit=".length), 10);
    else if (arg.startsWith("--company=")) a.company = arg.slice("--company=".length);
    else if (arg.startsWith("--out=")) a.out = arg.slice("--out=".length);
    else if (arg === "--force") a.force = true;
  }
  return a;
}

/**
 * Latest reviewer_edit per document. A document can be corrected more than
 * once (each correction is a new row, never an update); only the most recent
 * is the accepted ground truth, so earlier ones are dropped.
 */
function latestPerDocument(rows: ReviewerEditRow[]): ReviewerEditRow[] {
  const byDoc = new Map<string, ReviewerEditRow>();
  for (const row of rows) {
    const seen = byDoc.get(row.document_id);
    if (!seen || row.attempted_at > seen.attempted_at) byDoc.set(row.document_id, row);
  }
  return [...byDoc.values()];
}

function caseIdFor(row: ReviewerEditRow): string {
  const date = row.attempted_at.slice(0, 10);
  return `captured-${date}-${row.id.slice(0, 8)}`;
}

async function fetchReviewerEdits(supabase: SupabaseClient, args: Args): Promise<ReviewerEditRow[]> {
  let query = supabase
    .from("document_extractions")
    .select("id, company_id, document_id, parsed_data, confidence, reviewer_id, attempted_at")
    .eq("source", "reviewer_edit")
    .order("attempted_at", { ascending: false })
    .limit(args.limit);
  if (args.since) query = query.gte("attempted_at", args.since);
  if (args.company) query = query.eq("company_id", args.company);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to read document_extractions: ${error.message}`);
  return (data ?? []) as unknown as ReviewerEditRow[];
}

async function fetchDocument(supabase: SupabaseClient, documentId: string): Promise<DocumentRow | null> {
  const { data, error } = await supabase
    .from("vendor_documents")
    .select("storage_path, mime_type, file_name")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read vendor_documents ${documentId}: ${error.message}`);
  return (data as DocumentRow | null) ?? null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getAdminClient();

  console.log(`Reading reviewer corrections${args.since ? ` since ${args.since}` : ""}...`);
  const all = await fetchReviewerEdits(supabase, args);
  const latest = latestPerDocument(all);
  console.log(`  ${all.length} correction row(s); ${latest.length} distinct document(s).`);

  await mkdir(args.out, { recursive: true });

  let captured = 0;
  const skipped: string[] = [];

  for (const row of latest) {
    const caseId = caseIdFor(row);
    const caseDir = path.join(args.out, caseId);

    if (existsSync(caseDir) && !args.force) {
      skipped.push(`${caseId} (already captured; --force to overwrite)`);
      continue;
    }

    // Ground truth must be schema-valid, or it is not a usable golden answer.
    const parsed = InsuranceExtractionSchema.safeParse(normalizeExtraction(row.parsed_data));
    if (!parsed.success) {
      skipped.push(`${caseId} (correction failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"})`);
      continue;
    }

    const doc = await fetchDocument(supabase, row.document_id);
    if (!doc) {
      skipped.push(`${caseId} (source document ${row.document_id} not found)`);
      continue;
    }
    const ext = EXT_BY_MIME[doc.mime_type];
    if (!ext) {
      skipped.push(`${caseId} (unsupported mime_type ${doc.mime_type})`);
      continue;
    }

    const { data: blob, error: dlError } = await supabase.storage
      .from(VENDOR_DOCUMENTS_BUCKET)
      .download(doc.storage_path);
    if (dlError || !blob) {
      skipped.push(`${caseId} (could not download ${doc.storage_path}: ${dlError?.message ?? "no data"})`);
      continue;
    }

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, `document${ext}`), new Uint8Array(await blob.arrayBuffer()));
    await writeFile(path.join(caseDir, "expected.json"), JSON.stringify(parsed.data, null, 2) + "\n");
    await writeFile(
      path.join(caseDir, "provenance.json"),
      JSON.stringify(
        {
          extractionId: row.id,
          documentId: row.document_id,
          companyId: row.company_id,
          reviewerId: row.reviewer_id,
          correctedAt: row.attempted_at,
          sourceFileName: doc.file_name,
          mimeType: doc.mime_type,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    captured++;
    console.log(`  captured ${caseId}  (${doc.file_name})`);
  }

  if (skipped.length) {
    console.log("\nSkipped:");
    for (const s of skipped) console.log(`  - ${s}`);
  }

  console.log(
    `\nDone. ${captured} case(s) staged in ${args.out}/.\n` +
      `These are REAL certificates and are git-ignored. Review each one, confirm the\n` +
      `correction is right, redact anything that should not be retained, then move the\n` +
      `good cases into evals/coi-extraction/cases/ to add them to the eval set.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
