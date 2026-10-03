#!/usr/bin/env bun
/** Stages only staff-verified, explicitly retained public-scanner feedback. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdminClient } from "./lib/supabaseAdminClient";
import { InsuranceExtractionSchema, normalizeExtraction } from "../src/workflows/coiParserContract";

const BUCKET = "scanner-parser-feedback";
const DEFAULT_OUT = "evals/coi-extraction/captured-scanner";

export interface ScannerFeedbackRow {
  id: string;
  parser_run_id: string;
  corrected_extraction: unknown;
  retained_object_path: string | null;
  retention_consent: boolean;
  verified_status: string;
  reviewed_at: string | null;
  parser_metadata: unknown;
}

export function isEligibleScannerFeedback(row: ScannerFeedbackRow): boolean {
  return (
    row.verified_status === "verified" &&
    row.retention_consent &&
    Boolean(row.retained_object_path) &&
    Boolean(row.reviewed_at) &&
    InsuranceExtractionSchema.safeParse(normalizeExtraction(row.corrected_extraction)).success
  );
}

async function main() {
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const out = outArg?.slice("--out=".length) || DEFAULT_OUT;
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("scanner_parser_feedback")
    .select(
      "id,parser_run_id,corrected_extraction,retained_object_path,retention_consent,verified_status,reviewed_at,parser_metadata",
    )
    .eq("verified_status", "verified")
    .eq("retention_consent", true)
    .not("retained_object_path", "is", null);
  if (error) throw new Error(`Failed to read scanner feedback: ${error.message}`);
  await mkdir(out, { recursive: true });

  let captured = 0;
  for (const row of (data ?? []) as ScannerFeedbackRow[]) {
    if (!isEligibleScannerFeedback(row)) continue;
    const parsed = InsuranceExtractionSchema.parse(normalizeExtraction(row.corrected_extraction));
    const { data: blob, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(row.retained_object_path!);
    if (downloadError || !blob) continue;
    const ext = path.extname(row.retained_object_path!) || ".pdf";
    const caseDir = path.join(out, `scanner-${row.id}`);
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, `document${ext}`), new Uint8Array(await blob.arrayBuffer()));
    await writeFile(path.join(caseDir, "expected.json"), `${JSON.stringify(parsed, null, 2)}\n`);
    await writeFile(
      path.join(caseDir, "provenance.json"),
      `${JSON.stringify(
        {
          feedbackId: row.id,
          parserRunId: row.parser_run_id,
          reviewedAt: row.reviewed_at,
          parserMetadata: row.parser_metadata,
          capturedAt: new Date().toISOString(),
          source: "verified_public_scanner_feedback",
        },
        null,
        2,
      )}\n`,
    );
    captured += 1;
  }
  console.log(
    `Staged ${captured} verified scanner case(s) in ${out}. Manual redaction review is still required before promotion.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
