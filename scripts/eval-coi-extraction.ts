#!/usr/bin/env bun
/**
 * COI-extraction accuracy harness - a standalone operations/measurement
 * script, not application code. Same conventions as scripts/export-company.ts
 * and scripts/check-email-deliverability.ts: run by hand, never imported by
 * anything in src/**, never run on a schedule, Node/Bun-only APIs are fine
 * here because this never runs in the Cloudflare Workers request path.
 *
 * ---------------------------------------------------------------------------
 * What this is FOR
 * ---------------------------------------------------------------------------
 * You cannot tune the parser toward "most accurate" without a fixed yardstick:
 * a set of real certificates whose correct extraction is known, and a grader
 * that scores a run against it field-by-field. This script is that yardstick.
 * Run it before and after any change to the extraction prompt, model, or
 * effort setting and compare the headline number - that is the whole
 * instruct -> test -> re-instruct loop, made measurable.
 *
 * It calls the REAL Anthropic API through the SAME production extractor the
 * app ships (getDocumentExtractor() in src/workflows/documentExtraction.ts),
 * so the score reflects what vendors actually get - not a reimplementation
 * that could drift from production. That also means it COSTS MONEY and is
 * non-deterministic, which is exactly why it lives here as a manual script and
 * NOT in src/tests/** (that suite runs offline, in demo mode, with no API key,
 * and must stay deterministic).
 *
 * ---------------------------------------------------------------------------
 * Hill-climbing WITHOUT touching the three synced copies
 * ---------------------------------------------------------------------------
 * The production prompt/schema lives in THREE byte-for-byte copies
 * (src/workflows/, supabase/functions/process-document-jobs/,
 * supabase/functions/retry-failed-documents/) that must stay in sync. To
 * experiment with a new prompt/effort/model against the golden set WITHOUT
 * editing production first, drop an evals/coi-extraction/candidate.ts that
 * default-exports a DocumentExtractor (copy candidate.example.ts). If present,
 * this runner tests THAT extractor instead of production. Once a candidate
 * beats the baseline on the golden set, port the winning change into all three
 * copies - then delete candidate.ts so the harness is back to measuring
 * production.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   ANTHROPIC_API_KEY=sk-ant-... bun run eval:coi
 *   ANTHROPIC_API_KEY=sk-ant-... bun scripts/eval-coi-extraction.ts --limit=5
 *   ANTHROPIC_API_KEY=sk-ant-... bun scripts/eval-coi-extraction.ts --cases=some/other/dir
 *
 * Flags:
 *   --cases=<dir>   golden-set directory (default evals/coi-extraction/cases)
 *   --limit=<n>     only run the first n runnable cases (for a quick/cheap pass)
 *   --quiet         suppress the per-case breakdown, print only the summary
 *
 * See evals/coi-extraction/README.md for the golden-set layout and the
 * grading philosophy (why hallucinations and misses are reported separately,
 * why confidence routing gets its own 2x2, how to add a case).
 */
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  getDocumentExtractor,
  type DocumentExtractor,
  type ExtractDocumentResult,
} from "../src/workflows/documentExtraction";
import {
  InsuranceExtractionSchema,
  normalizeExtraction,
  type ExtractedPolicy,
  type InsuranceExtraction,
} from "../src/workflows/insuranceExtractionSchema";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CASES_DIR = "evals/coi-extraction/cases";
const REPORTS_DIR = "evals/coi-extraction/reports";
const CANDIDATE_PATH = "evals/coi-extraction/candidate.ts";

/** Mirrors CONFIDENCE_NEEDS_REVIEW_BELOW in documentExtraction.ts. */
const CONFIDENCE_NEEDS_REVIEW_BELOW = 0.6;
/** A case whose field accuracy is at or above this is "safe to auto-process". */
const SAFE_AUTO_ACCURACY = 0.95;

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

// ---------------------------------------------------------------------------
// Field comparison
// ---------------------------------------------------------------------------

type FieldKind = "string" | "number" | "date" | "bool" | "stringArray";
/** correct also covers both-null; the three wrong kinds are reported apart. */
type Outcome = "correct" | "miss" | "hallucination" | "mismatch";

interface FieldSpec {
  /** Dotted label used in the aggregate report, e.g. "policy.expiration_date". */
  label: string;
  kind: FieldKind;
  expected: unknown;
  actual: unknown;
}

function coalesce(v: unknown): unknown {
  return v === undefined ? null : v;
}

function normString(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stringsMatch(exp: string, act: string): boolean {
  const e = normString(exp);
  const a = normString(act);
  if (e === "" && a === "") return true;
  if (e === a) return true;
  // Containment (e.g. "ACME Insurance Co" vs "ACME Insurance Company").
  if (e.length >= 4 && a.length >= 4 && (a.includes(e) || e.includes(a))) return true;
  // Token Jaccard for reordered / abbreviated names and addresses.
  const et = new Set(e.split(" "));
  const at = new Set(a.split(" "));
  let inter = 0;
  for (const t of et) if (at.has(t)) inter++;
  const union = new Set([...et, ...at]).size;
  return union > 0 && inter / union >= 0.6;
}

function normFormToken(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function compareField(kind: FieldKind, expRaw: unknown, actRaw: unknown): Outcome {
  const exp = coalesce(expRaw);
  const act = coalesce(actRaw);
  if (exp === null && act === null) return "correct";
  if (exp === null && act !== null) return "hallucination";
  if (exp !== null && act === null) return "miss";

  switch (kind) {
    case "string":
      return stringsMatch(String(exp), String(act)) ? "correct" : "mismatch";
    case "number":
      return Number(exp) === Number(act) ? "correct" : "mismatch";
    case "date":
      return String(exp) === String(act) ? "correct" : "mismatch";
    case "bool":
      return exp === act ? "correct" : "mismatch";
    case "stringArray": {
      const e = new Set((exp as string[]).map(normFormToken));
      const a = new Set((act as string[]).map(normFormToken));
      if (e.size !== a.size) return "mismatch";
      for (const t of e) if (!a.has(t)) return "mismatch";
      return "correct";
    }
    default:
      return "mismatch";
  }
}

// ---------------------------------------------------------------------------
// Per-policy and top-level field extraction
// ---------------------------------------------------------------------------

function topLevelSpecs(exp: InsuranceExtraction, act: InsuranceExtraction): FieldSpec[] {
  return [
    { label: "document_type", kind: "string", expected: exp.document_type, actual: act.document_type },
    { label: "insured.name", kind: "string", expected: exp.insured.name, actual: act.insured.name },
    { label: "insured.address", kind: "string", expected: exp.insured.address, actual: act.insured.address },
    { label: "producer.name", kind: "string", expected: exp.producer.name, actual: act.producer.name },
    {
      label: "certificate_holder.name",
      kind: "string",
      expected: exp.certificate_holder.name,
      actual: act.certificate_holder.name,
    },
    {
      label: "certificate_holder.address",
      kind: "string",
      expected: exp.certificate_holder.address,
      actual: act.certificate_holder.address,
    },
  ];
}

/** actual may be a real policy or null (expected policy had no match at all). */
function policySpecs(exp: ExtractedPolicy, act: ExtractedPolicy | null): FieldSpec[] {
  const a: Partial<ExtractedPolicy> = act ?? {};
  const el = exp.employers_liability ?? {};
  const ael = a.employers_liability ?? {};
  return [
    { label: "policy.carrier", kind: "string", expected: exp.carrier, actual: a.carrier },
    { label: "policy.policy_number", kind: "string", expected: exp.policy_number, actual: a.policy_number },
    { label: "policy.effective_date", kind: "date", expected: exp.effective_date, actual: a.effective_date },
    { label: "policy.expiration_date", kind: "date", expected: exp.expiration_date, actual: a.expiration_date },
    {
      label: "policy.limits.each_occurrence",
      kind: "number",
      expected: exp.limits.each_occurrence,
      actual: a.limits?.each_occurrence,
    },
    {
      label: "policy.limits.general_aggregate",
      kind: "number",
      expected: exp.limits.general_aggregate,
      actual: a.limits?.general_aggregate,
    },
    { label: "policy.additional_insured", kind: "bool", expected: exp.additional_insured, actual: a.additional_insured },
    {
      label: "policy.waiver_of_subrogation",
      kind: "bool",
      expected: exp.waiver_of_subrogation,
      actual: a.waiver_of_subrogation,
    },
    {
      label: "policy.primary_noncontributory",
      kind: "bool",
      expected: exp.primary_noncontributory,
      actual: a.primary_noncontributory,
    },
    {
      label: "policy.additional_insured_ongoing_operations",
      kind: "bool",
      expected: exp.additional_insured_ongoing_operations,
      actual: a.additional_insured_ongoing_operations,
    },
    {
      label: "policy.additional_insured_completed_operations",
      kind: "bool",
      expected: exp.additional_insured_completed_operations,
      actual: a.additional_insured_completed_operations,
    },
    {
      label: "policy.cancellation_notice_provided",
      kind: "bool",
      expected: exp.cancellation_notice_provided,
      actual: a.cancellation_notice_provided,
    },
    {
      label: "policy.cancellation_notice_days",
      kind: "number",
      expected: exp.cancellation_notice_days,
      actual: a.cancellation_notice_days,
    },
    {
      label: "policy.employers_liability.each_accident",
      kind: "number",
      expected: el.each_accident,
      actual: ael.each_accident,
    },
    {
      label: "policy.employers_liability.disease_each_employee",
      kind: "number",
      expected: el.disease_each_employee,
      actual: ael.disease_each_employee,
    },
    {
      label: "policy.employers_liability.disease_policy_limit",
      kind: "number",
      expected: el.disease_policy_limit,
      actual: ael.disease_policy_limit,
    },
    { label: "policy.follows_form", kind: "bool", expected: exp.follows_form, actual: a.follows_form },
    {
      label: "policy.endorsement_forms",
      kind: "stringArray",
      expected: exp.endorsement_forms,
      actual: a.endorsement_forms,
    },
  ];
}

// ---------------------------------------------------------------------------
// Grading one case
// ---------------------------------------------------------------------------

interface CaseGrade {
  caseId: string;
  outcomes: Array<{ label: string; outcome: Outcome }>;
  /** correct / graded for this case, 1 when there is nothing to grade. */
  accuracy: number;
  confidence: number | null;
  autoProcessed: boolean;
  /** expected vs actual policy-type multisets ("__unclassified__" for a null type). */
  policyExpected: string[];
  policyActual: string[];
  phantomPolicies: number;
  missingPolicies: number;
  error: string | null;
}

function typeKey(p: ExtractedPolicy): string {
  return p.type ?? "__unclassified__";
}

function gradeCase(
  caseId: string,
  expected: InsuranceExtraction,
  result: ExtractDocumentResult,
): CaseGrade {
  const outcomes: Array<{ label: string; outcome: Outcome }> = [];

  if (!result.data) {
    // No usable extraction at all (failed / validation-rejected). Every
    // expected non-null field counts as a miss - a blank result is not a
    // neutral result, it is a wrong one.
    const expSpecs = [
      ...topLevelSpecs(expected, expected).map((s) => ({ ...s, actual: null })),
      ...expected.policies.flatMap((p) => policySpecs(p, null)),
    ];
    for (const s of expSpecs) {
      outcomes.push({ label: s.label, outcome: compareField(s.kind, s.expected, null) });
    }
    const graded = outcomes.length;
    const correct = outcomes.filter((o) => o.outcome === "correct").length;
    return {
      caseId,
      outcomes,
      accuracy: graded === 0 ? 1 : correct / graded,
      confidence: result.confidence,
      autoProcessed: false,
      policyExpected: expected.policies.map((p) => p.type ?? "__unclassified__"),
      policyActual: [],
      phantomPolicies: 0,
      missingPolicies: expected.policies.length,
      error: result.error ?? "No extraction data returned.",
    };
  }

  const actual = result.data;

  for (const s of topLevelSpecs(expected, actual)) {
    outcomes.push({ label: s.label, outcome: compareField(s.kind, s.expected, s.actual) });
  }

  // Match policies by type, zipping within a type bucket by order so a
  // certificate with two of the same coverage type still lines up.
  const actualByType = new Map<string, ExtractedPolicy[]>();
  for (const p of actual.policies) {
    const k = typeKey(p);
    (actualByType.get(k) ?? actualByType.set(k, []).get(k)!).push(p);
  }
  const consumed = new Map<string, number>();
  let missingPolicies = 0;

  for (const exp of expected.policies) {
    const k = typeKey(exp);
    const idx = consumed.get(k) ?? 0;
    const bucket = actualByType.get(k) ?? [];
    const match = bucket[idx] ?? null;
    consumed.set(k, idx + 1);
    if (!match) missingPolicies++;
    for (const s of policySpecs(exp, match)) {
      outcomes.push({ label: s.label, outcome: compareField(s.kind, s.expected, s.actual) });
    }
  }

  // Policies the model produced beyond what any expected bucket consumed.
  let phantomPolicies = 0;
  for (const [k, bucket] of actualByType) {
    const used = consumed.get(k) ?? 0;
    if (bucket.length > used) phantomPolicies += bucket.length - used;
  }

  const graded = outcomes.length;
  const correct = outcomes.filter((o) => o.outcome === "correct").length;
  const autoProcessed =
    result.status === "processed" &&
    result.confidence !== null &&
    result.confidence >= CONFIDENCE_NEEDS_REVIEW_BELOW;

  return {
    caseId,
    outcomes,
    accuracy: graded === 0 ? 1 : correct / graded,
    confidence: result.confidence,
    autoProcessed,
    policyExpected: expected.policies.map((p) => p.type ?? "__unclassified__"),
    policyActual: actual.policies.map((p) => p.type ?? "__unclassified__"),
    phantomPolicies,
    missingPolicies,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Golden-set loading
// ---------------------------------------------------------------------------

interface RunnableCase {
  caseId: string;
  documentPath: string;
  mimeType: string;
  expected: InsuranceExtraction;
}

async function loadExpected(file: string): Promise<InsuranceExtraction> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const parsed = InsuranceExtractionSchema.safeParse(normalizeExtraction(raw));
  if (!parsed.success) {
    throw new Error(
      `expected.json is not a valid extraction shape:\n  ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n  ")}`,
    );
  }
  return parsed.data;
}

async function findDocument(caseDir: string): Promise<{ path: string; mimeType: string } | null> {
  for (const entry of await readdir(caseDir)) {
    const ext = path.extname(entry).toLowerCase();
    const base = path.basename(entry, ext).toLowerCase();
    if (base === "document" && MIME_BY_EXT[ext]) {
      return { path: path.join(caseDir, entry), mimeType: MIME_BY_EXT[ext]! };
    }
  }
  return null;
}

async function loadCases(casesDir: string): Promise<{ runnable: RunnableCase[]; skipped: string[] }> {
  const runnable: RunnableCase[] = [];
  const skipped: string[] = [];
  if (!existsSync(casesDir)) return { runnable, skipped };

  for (const entry of (await readdir(casesDir)).sort()) {
    const caseDir = path.join(casesDir, entry);
    if (!(await stat(caseDir)).isDirectory()) continue;
    const expectedFile = path.join(caseDir, "expected.json");
    if (!existsSync(expectedFile)) continue; // not a case dir

    const doc = await findDocument(caseDir);
    if (!doc) {
      skipped.push(`${entry} (expected.json present but no document.{pdf,png,jpg,jpeg})`);
      continue;
    }
    try {
      runnable.push({
        caseId: entry,
        documentPath: doc.path,
        mimeType: doc.mimeType,
        expected: await loadExpected(expectedFile),
      });
    } catch (err) {
      skipped.push(`${entry} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { runnable, skipped };
}

// ---------------------------------------------------------------------------
// Candidate extractor override (optional)
// ---------------------------------------------------------------------------

async function resolveExtractor(): Promise<{ extractor: DocumentExtractor; source: string }> {
  if (existsSync(CANDIDATE_PATH)) {
    const mod = (await import(pathToFileURL(path.resolve(CANDIDATE_PATH)).href)) as {
      default?: DocumentExtractor;
    };
    if (mod.default && typeof mod.default.extract === "function") {
      return { extractor: mod.default, source: `candidate (${CANDIDATE_PATH})` };
    }
    throw new Error(`${CANDIDATE_PATH} exists but does not default-export a DocumentExtractor.`);
  }
  return { extractor: getDocumentExtractor(), source: "production (src/workflows/documentExtraction.ts)" };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

function printReport(grades: CaseGrade[], source: string, quiet: boolean): unknown {
  // Aggregate per-field outcomes.
  const byField = new Map<string, Record<Outcome, number>>();
  for (const g of grades) {
    for (const o of g.outcomes) {
      const row = byField.get(o.label) ?? { correct: 0, miss: 0, hallucination: 0, mismatch: 0 };
      row[o.outcome]++;
      byField.set(o.label, row);
    }
  }

  let totalCorrect = 0;
  let totalGraded = 0;
  let totalHalluc = 0;
  let totalMiss = 0;
  let totalMismatch = 0;
  for (const row of byField.values()) {
    totalCorrect += row.correct;
    totalHalluc += row.hallucination;
    totalMiss += row.miss;
    totalMismatch += row.mismatch;
    totalGraded += row.correct + row.miss + row.hallucination + row.mismatch;
  }

  // Routing 2x2.
  const quadrant = { autoSafe: 0, autoUnsafe: [] as string[], heldCorrectly: 0, heldOvercautious: 0 };
  for (const g of grades) {
    if (g.autoProcessed) {
      if (g.accuracy >= SAFE_AUTO_ACCURACY) quadrant.autoSafe++;
      else quadrant.autoUnsafe.push(`${g.caseId} (acc ${pct(g.accuracy, 1).replace("%", "")}%)`);
    } else {
      if (g.accuracy >= SAFE_AUTO_ACCURACY) quadrant.heldOvercautious++;
      else quadrant.heldCorrectly++;
    }
  }

  // Policy-set precision/recall across all cases (multiset of types).
  let policyTP = 0;
  let policyFP = 0;
  let policyFN = 0;
  for (const g of grades) {
    const exp = [...g.policyExpected];
    for (const t of g.policyActual) {
      const i = exp.indexOf(t);
      if (i >= 0) {
        policyTP++;
        exp.splice(i, 1);
      } else {
        policyFP++;
      }
    }
    policyFN += exp.length;
  }

  console.log("\n" + "=".repeat(72));
  console.log("COI EXTRACTION EVAL");
  console.log("=".repeat(72));
  console.log(`Extractor under test : ${source}`);
  console.log(`Cases run            : ${grades.length}`);
  console.log(`Model confidence     : ${CONFIDENCE_NEEDS_REVIEW_BELOW}+ auto-processes`);
  console.log("-".repeat(72));
  console.log(`HEADLINE field accuracy : ${pct(totalCorrect, totalGraded)}  (${totalCorrect}/${totalGraded})`);
  console.log(
    `  wrong breakdown        : ${totalMiss} miss (said null, had value) · ` +
      `${totalHalluc} hallucination (said value, was null) · ${totalMismatch} mismatch`,
  );
  console.log(
    `Policy detection        : P ${pct(policyTP, policyTP + policyFP)} · ` +
      `R ${pct(policyTP, policyTP + policyFN)}  (TP ${policyTP} / FP ${policyFP} / FN ${policyFN})`,
  );
  console.log("-".repeat(72));
  console.log("CONFIDENCE ROUTING (the number new users feel)");
  console.log(`  auto-processed & safe (>=${SAFE_AUTO_ACCURACY * 100}%) : ${quadrant.autoSafe}`);
  console.log(
    `  auto-processed & WRONG            : ${quadrant.autoUnsafe.length}` +
      (quadrant.autoUnsafe.length ? `  <-- trust-killers: ${quadrant.autoUnsafe.join(", ")}` : ""),
  );
  console.log(`  held for review, rightly          : ${quadrant.heldCorrectly}`);
  console.log(`  held for review, overcautious     : ${quadrant.heldOvercautious}`);

  // Per-field table, worst accuracy first - this is where you aim the next
  // round of prompt tuning.
  const fieldRows = [...byField.entries()]
    .map(([label, r]) => {
      const total = r.correct + r.miss + r.hallucination + r.mismatch;
      return { label, ...r, total, acc: total === 0 ? 1 : r.correct / total };
    })
    .sort((a, b) => a.acc - b.acc);

  console.log("-".repeat(72));
  console.log("PER-FIELD ACCURACY (worst first - aim tuning here)");
  for (const f of fieldRows) {
    const flags = [
      f.miss ? `${f.miss} miss` : "",
      f.hallucination ? `${f.hallucination} halluc` : "",
      f.mismatch ? `${f.mismatch} mism` : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${pct(f.correct, f.total).padStart(6)}  ${f.label.padEnd(48)} ${flags ? "(" + flags + ")" : ""}`,
    );
  }

  if (!quiet) {
    console.log("-".repeat(72));
    console.log("PER-CASE");
    for (const g of grades) {
      const conf = g.confidence === null ? "  n/a" : g.confidence.toFixed(2);
      const extra = [
        g.phantomPolicies ? `${g.phantomPolicies} phantom-policy` : "",
        g.missingPolicies ? `${g.missingPolicies} missing-policy` : "",
        g.error ? `ERROR: ${g.error}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      console.log(
        `  ${pct(g.accuracy, 1).padStart(6)}  conf ${conf}  ` +
          `${g.autoProcessed ? "AUTO " : "review"}  ${g.caseId}${extra ? "  — " + extra : ""}`,
      );
    }
  }
  console.log("=".repeat(72) + "\n");

  return {
    generatedAt: new Date().toISOString(),
    extractorSource: source,
    casesRun: grades.length,
    headline: { correct: totalCorrect, graded: totalGraded, accuracy: totalGraded ? totalCorrect / totalGraded : 1 },
    wrong: { miss: totalMiss, hallucination: totalHalluc, mismatch: totalMismatch },
    policyDetection: { tp: policyTP, fp: policyFP, fn: policyFN },
    routing: {
      autoSafe: quadrant.autoSafe,
      autoUnsafe: quadrant.autoUnsafe,
      heldCorrectly: quadrant.heldCorrectly,
      heldOvercautious: quadrant.heldOvercautious,
    },
    perField: fieldRows,
    perCase: grades,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { casesDir: string; limit: number | null; quiet: boolean } {
  let casesDir = DEFAULT_CASES_DIR;
  let limit: number | null = null;
  let quiet = false;
  for (const arg of argv) {
    if (arg.startsWith("--cases=")) casesDir = arg.slice("--cases=".length);
    else if (arg.startsWith("--limit=")) limit = Number.parseInt(arg.slice("--limit=".length), 10);
    else if (arg === "--quiet") quiet = true;
  }
  return { casesDir, limit, quiet };
}

async function main(): Promise<void> {
  const { casesDir, limit, quiet } = parseArgs(process.argv.slice(2));

  const { runnable, skipped } = await loadCases(casesDir);
  if (skipped.length) {
    console.warn("Skipped cases:");
    for (const s of skipped) console.warn(`  - ${s}`);
  }
  if (runnable.length === 0) {
    console.error(
      `\nNo runnable cases in '${casesDir}'. A case is a subdirectory with an\n` +
        `expected.json AND a document.{pdf,png,jpg,jpeg}. See\n` +
        `evals/coi-extraction/README.md for how to build the golden set.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { extractor, source } = await resolveExtractor();
  const toRun = limit ? runnable.slice(0, limit) : runnable;

  console.log(`Running ${toRun.length} case(s) against ${source} ...`);
  console.log("This calls the real Anthropic API and will incur cost.\n");

  const grades: CaseGrade[] = [];
  for (const c of toRun) {
    process.stdout.write(`  • ${c.caseId} ... `);
    // Slice to the exact file bytes: Node pools small Buffers, so `.buffer`
    // alone can carry unrelated bytes from the shared pool into the encoder.
    const buf = await readFile(c.documentPath);
    const fileBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const result = await extractor.extract({ fileBytes, mimeType: c.mimeType });

    if (result.status === "not_configured") {
      console.error(
        "\nExtraction is not configured - ANTHROPIC_API_KEY is unset. The eval\n" +
          "must run against the real model. Set the key and re-run.\n",
      );
      process.exitCode = 1;
      return;
    }

    const grade = gradeCase(c.caseId, c.expected, result);
    grades.push(grade);
    console.log(`${pct(grade.accuracy, 1)} (conf ${grade.confidence ?? "n/a"})`);
  }

  const report = printReport(grades, source, quiet);

  await mkdir(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Full report written to ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
