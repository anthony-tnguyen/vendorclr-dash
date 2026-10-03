# VendorClr COI Parser and Free Scanner Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public COI scanner consume the canonical production parser contract, eliminate false compliance passes and invented re-check/correction claims, and add privacy-safe provenance, lineage, and feedback foundations.

**Architecture:** `vendorclr-dash` owns one canonical Zod parser contract and a generator for Deno/browser adapters. Paid workers and the free Edge Function import generated adapters; `vendorclear` maps only validated canonical output into scanner evidence. A forward-only scanner migration and service-role Edge endpoint persist provenance and pending feedback without allowing anonymous writes to production truth.

**Tech Stack:** TypeScript 5.9, Bun, Vitest, React 18/19, Zod 3.25, Supabase Deno Edge Functions, PostgreSQL/RLS, PGlite, Anthropic SDK 0.122.

**Spec:** `docs/superpowers/specs/2026-10-02-coi-parser-scanner-hardening-design.md`

## Global Constraints

- Unknown, unreadable, ambiguous, low-confidence, or schema-invalid evidence must never become `pass` or a factual deficiency.
- Real uploaded re-checks must preserve parser output exactly; deterministic correction simulation is sample/demo only.
- `vendorclr-dash` is the canonical parser-contract owner; generated runtime copies cannot redefine model, prompt, schema, versions, normalization, or critical rules.
- Keep Supabase Edge Runtime compatibility and pin Deno/npm imports.
- Add a new forward-only migration; never edit an applied migration.
- Raw files are discarded unless the user separately and explicitly consents to parser-improvement retention.
- Anonymous feedback never overwrites production extraction truth and is never a golden case until staff verification.
- Preserve the Requirements Builder -> Scanner -> Correction Generator journey and existing upload MIME/size controls.
- Do not claim a live COI parse unless an actual provider call is run.

## Review Focus

- A low-confidence but numerically adequate GL limit must be held for review, not passed; Task 4 adds this mutation test.
- A form string with an edition suffix or punctuation must normalize without matching a neighboring form; Task 3 tests `CG 20 10 07 04`, `CG-24-04`, and `CG 20 11`.
- A second re-check must compare against the first re-check while retaining the original root; Task 6 tests a three-report chain.
- Feedback with consent but a missing/oversized/unsupported file must not create a retained-object reference; Task 7 tests all three branches.
- A public caller must not read, update, verify, or directly insert feedback despite knowing IDs; Task 7 adds PGlite RLS/grant assertions.

---

### Task 1: Canonical parser contract and deterministic adapters (`vendorclr-dash`)

**Files:**

- Create: `src/workflows/coiParserContract.ts`
- Create: `scripts/sync-coi-parser-contract.ts`
- Create: `supabase/functions/_shared/coiParserContract.ts`
- Modify: `src/workflows/insuranceExtractionSchema.ts`
- Modify: `package.json`
- Test: `src/tests/coi-parser-contract.test.ts`

**Interfaces:**

- Produces: `InsuranceExtractionSchema`, `normalizeExtraction(raw)`, `parseExtractionResponse(text)`, `PARSER_METADATA`, `PARSER_CONTRACT_FINGERPRINT`, `SYSTEM_PROMPT`, and `INSURANCE_EXTRACTION_JSON_SHAPE`.
- Produces: `bun run sync:coi-parser-contract` and `bun run check:coi-parser-contract`.
- Consumes: existing extraction shape and prompt semantics from `insuranceExtractionSchema.ts` and `documentExtraction.ts`.

- [ ] **Step 1: Write failing canonical-contract tests**

```ts
it("normalizes synonyms before strict validation", () => {
  const result = parseExtractionResponse(
    JSON.stringify(validExtraction({ type: "Commercial General Liability" })),
  );
  expect(result.success).toBe(true);
  expect(result.data?.policies[0]?.type).toBe("general_liability");
});

it.each([
  "not json",
  JSON.stringify({ policies: [] }),
  JSON.stringify(validExtraction({ overall_confidence: 2 })),
])("rejects malformed or incomplete output: %s", (text) =>
  expect(parseExtractionResponse(text).success).toBe(false),
);

it("keeps the committed fingerprint equal to the semantic contract hash", () => {
  expect(PARSER_CONTRACT_FINGERPRINT).toBe(computeParserContractFingerprint());
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bunx vitest run src/tests/coi-parser-contract.test.ts`

Expected: FAIL because `coiParserContract.ts` and fingerprint exports do not exist.

- [ ] **Step 3: Implement the canonical contract**

```ts
export const EXTRACTION_PROVIDER = "anthropic";
export const EXTRACTION_MODEL = "claude-opus-5";
export const PARSER_VERSION = "2026-10-02-v1";
export const EXTRACTION_SCHEMA_VERSION = "2026-10-02-v1";
export const EXTRACTION_PROMPT_VERSION = "2026-10-02-v1";
export const CONFIDENCE_NEEDS_REVIEW_BELOW = 0.6;

export const PARSER_METADATA = {
  provider: EXTRACTION_PROVIDER,
  model: EXTRACTION_MODEL,
  parserVersion: PARSER_VERSION,
  schemaVersion: EXTRACTION_SCHEMA_VERSION,
  promptVersion: EXTRACTION_PROMPT_VERSION,
  contractFingerprint: PARSER_CONTRACT_FINGERPRINT,
} as const;
```

Move the complete Zod schema, synonym normalizer, safe parser, JSON shape, and production prompt into this file. Keep `insuranceExtractionSchema.ts` as a compatibility re-export so existing imports continue working.

- [ ] **Step 4: Implement adapter generation and check mode**

```ts
// scripts/sync-coi-parser-contract.ts
const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const vendorclearDir = valueAfter("--vendorclear-dir");
const targets = [
  dashboardDenoTarget,
  ...(vendorclearDir ? [vendorclearDenoTarget, vendorclearBrowserTarget] : []),
];
for (const target of targets) await writeOrCheck(target, renderTarget(target));
```

Generate the Deno adapter by changing only the Zod import to `npm:zod@3.25.76`. Generate the browser contract with schema/types/metadata but without the system prompt. Check mode exits nonzero on any byte difference.

- [ ] **Step 5: Run RED-to-GREEN checks**

Run: `bun run sync:coi-parser-contract -- --vendorclear-dir ../vendorclear-coi-scanner-hardening`

Run: `bunx vitest run src/tests/coi-parser-contract.test.ts`

Run: `bun run check:coi-parser-contract -- --vendorclear-dir ../vendorclear-coi-scanner-hardening`

Expected: all exit 0; the committed fingerprint matches the semantic contract.

- [ ] **Step 6: Commit Task 1**

```powershell
git add src/workflows/coiParserContract.ts src/workflows/insuranceExtractionSchema.ts src/tests/coi-parser-contract.test.ts scripts/sync-coi-parser-contract.ts supabase/functions/_shared/coiParserContract.ts package.json
git commit -m "feat: centralize COI parser contract"
```

### Task 2: Move production and retry workers onto the shared contract (`vendorclr-dash`)

**Files:**

- Modify: `src/workflows/documentExtraction.ts`
- Modify: `supabase/functions/process-document-jobs/documentExtraction.ts`
- Modify: `supabase/functions/process-document-jobs/index.ts`
- Modify: `supabase/functions/retry-failed-documents/documentExtraction.ts`
- Modify: `supabase/functions/retry-failed-documents/index.ts`
- Delete: `supabase/functions/process-document-jobs/insuranceExtractionSchema.ts`
- Delete: `supabase/functions/retry-failed-documents/insuranceExtractionSchema.ts`
- Test: `src/tests/document-extraction.test.ts`
- Test: `src/tests/coi-parser-contract.test.ts`

**Interfaces:**

- Consumes: Task 1 canonical exports and generated Deno adapter.
- Produces: every paid/retry call records the same `PARSER_METADATA` values and uses the same strict parser.

- [ ] **Step 1: Add failing worker-equivalence tests**

```ts
it("uses canonical model, prompt and confidence threshold", () => {
  expect({ model: EXTRACTION_MODEL, promptVersion: EXTRACTION_PROMPT_VERSION }).toEqual(
    PARSER_METADATA,
  );
  expect(statusForConfidence(0.59)).toBe("needs_review");
  expect(statusForConfidence(0.6)).toBe("processed");
});
```

Add a source-generation assertion proving both worker imports point to `../_shared/coiParserContract.ts` and no worker-local schema file is generated.

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run src/tests/document-extraction.test.ts src/tests/coi-parser-contract.test.ts`

Expected: FAIL because workers still own local copies/constants.

- [ ] **Step 3: Refactor all extractors and metadata writes**

```ts
import {
  CONFIDENCE_NEEDS_REVIEW_BELOW,
  PARSER_METADATA,
  SYSTEM_PROMPT,
  parseExtractionResponse,
  type InsuranceExtraction,
} from "./coiParserContract";
```

Use `PARSER_METADATA.provider/model/promptVersion` in every `record_document_extraction` call. Remove hard-coded model/schema constants from worker indexes and remove both worker-local schema files.

- [ ] **Step 4: Verify GREEN and generated-copy cleanliness**

Run: `bunx vitest run src/tests/document-extraction.test.ts src/tests/insurance-extraction-schema.test.ts src/tests/expanded-extraction.test.ts src/tests/coi-parser-contract.test.ts`

Run: `bun run check:coi-parser-contract -- --vendorclear-dir ../vendorclear-coi-scanner-hardening`

Expected: all pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/workflows supabase/functions/process-document-jobs supabase/functions/retry-failed-documents src/tests
git commit -m "refactor: share parser contract across workers"
```

### Task 3: Strict free parsing and form-aware endorsement mapping (`vendorclear`)

**Files:**

- Create: `supabase/functions/analyze-coi/scannerMapping.ts`
- Modify: `supabase/functions/analyze-coi/index.ts`
- Modify: `src/lib/scanner-analysis.ts`
- Modify: `src/lib/scanner-types.ts`
- Test: `src/test/scanner-parser.test.ts`

**Interfaces:**

- Consumes: generated `_shared/coiParserContract.ts` and browser contract from Task 1.
- Produces: `mapInsuranceExtraction(extraction)` and a response envelope `{ extracted, canonicalExtraction, parserRunId, parserMetadata }`.
- Produces: `EndorsementEvidence` with `verified_form | wording_only | ambiguous_form | no_evidence`.

- [ ] **Step 1: Write failing parser/mapping tests**

```ts
it.each([
  [["CG 20 10 07 04"], "verified_form", "no_evidence"],
  [["CG-24-04"], "no_evidence", "verified_form"],
  [["CG 20 11"], "ambiguous_form", "ambiguous_form"],
])("maps forms without cross-satisfying requirements", (forms, aiState, wosState) => {
  const mapped = mapInsuranceExtraction(extractionWithForms(forms));
  expect(mapped.additionalInsured.state).toBe(aiState);
  expect(mapped.waiverOfSubrogation.state).toBe(wosState);
});

it("marks wording without a form as wording_only", () => {
  const mapped = mapInsuranceExtraction(
    extractionWith({ additional_insured: true, endorsement_forms: null }),
  );
  expect(mapped.additionalInsured.state).toBe("wording_only");
});
```

Add tests for `CG 20 37`, `CG 20 01`, an AI form not satisfying WOS, a WOS form not satisfying AI, malformed JSON, incomplete output, synonyms, and low confidence.

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run src/test/scanner-parser.test.ts`

Expected: FAIL because form-aware mapping and the response envelope do not exist.

- [ ] **Step 3: Implement deterministic form classification**

```ts
export type EndorsementEvidenceState =
  "verified_form" | "wording_only" | "ambiguous_form" | "no_evidence";

const FORM_SUPPORT = {
  CG2010: ["additional_insured", "additional_insured_ongoing"],
  CG2037: ["additional_insured", "additional_insured_completed"],
  CG2404: ["waiver_of_subrogation"],
  CG2001: ["primary_noncontributory"],
} as const;
```

Normalize only exact base forms. Treat recognized unrelated forms as no evidence and unknown CG forms as ambiguous; never infer attachment from `forms.length > 0`.

- [ ] **Step 4: Replace weak model parsing**

```ts
const parsed = parseExtractionResponse(text);
if (!parsed.success || !parsed.data) return json({ error: "analysis_validation_failed" }, 502);
const extracted = mapInsuranceExtraction(parsed.data);
return json({ extracted, canonicalExtraction: parsed.data, parserRunId, parserMetadata }, 200);
```

Persist the validated parser run with service-role credentials; never persist raw file bytes here.

- [ ] **Step 5: Validate the browser trust boundary**

Use the generated browser schema for `canonicalExtraction`, a strict metadata schema, and the existing strict mapped-extraction schema. Reject a malformed envelope with `AnalysisError("service")`.

- [ ] **Step 6: Run focused tests and commit Task 3**

Run: `bunx vitest run src/test/scanner-parser.test.ts src/test/coi-scanner.test.tsx`

Expected: all pass.

```powershell
git add supabase/functions src/lib src/test/scanner-parser.test.ts src/test/coi-scanner.test.tsx
git commit -m "fix: validate free COI parsing and match endorsement forms"
```

### Task 4: Conservative scanner confidence and real re-check integrity (`vendorclear`)

**Files:**

- Modify: `src/lib/scanner-rules.ts`
- Modify: `src/lib/scanner-run.ts`
- Modify: `src/lib/scanner-sample.ts`
- Modify: `src/lib/scanner-types.ts`
- Test: `src/test/coi-scanner.test.tsx`

**Interfaces:**

- Consumes: Task 3 `EndorsementEvidence`, parser metadata, and review state.
- Produces: `runRecheck()` with separate real and sample branches; low confidence cannot pass.

- [ ] **Step 1: Add failing re-check and confidence tests**

```ts
it("does not mutate a real parsed re-check", async () => {
  const parsed = serviceAnalysis({
    additionalInsured: noEvidence(),
    waiverOfSubrogation: noEvidence(),
    primaryNoncontributory: noEvidence(),
    certificateHolder: field(null, "low"),
    endorsementsDetected: [],
  });
  const recheck = buildRealRecheck(original, parsed, NOW);
  expect(recheck.result.extracted).toEqual(parsed.extracted);
  expect(recheck.result.extracted.endorsementsDetected).toEqual([]);
});

it("does not pass an adequate low-confidence GL limit", () => {
  const finding = evaluate(lowConfidenceExtraction(1_000_000), SAMPLE_REQUIREMENTS, NOW).find(
    (row) => row.key === "general_liability",
  );
  expect(finding?.status).toBe("could_not_determine");
});
```

Include separate assertions that real re-check does not add AI, WOS, PNC, holder, `CG 20 10`, `CG 20 37`, or `CG 24 04`; sample re-check still resolves deterministic demo gaps.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `bunx vitest run src/test/coi-scanner.test.tsx`

Expected: real re-check mutation and low-confidence pass tests fail.

- [ ] **Step 3: Split sample and real re-check execution**

```ts
if (input.file) {
  const analysis = await analyzeCoiDocument(input);
  return compareRecheck(previous, buildResultFromAnalysis(previous, analysis, now));
}
return compareRecheck(previous, buildSampleRecheck(previous, now));
```

Rename the sample helper to make its scope explicit and ensure no service-mode call imports or invokes it.

- [ ] **Step 4: Enforce evidence/confidence in scanner rules**

Only `verified_form` passes endorsements. Convert any low-confidence would-be pass or deficiency into `could_not_determine`/`verification_required` with clarification language.

- [ ] **Step 5: Run GREEN tests and commit Task 4**

Run: `bunx vitest run src/test/coi-scanner.test.tsx src/test/scanner-parser.test.ts`

Expected: all pass.

```powershell
git add src/lib src/test/coi-scanner.test.tsx src/test/scanner-parser.test.ts
git commit -m "fix: preserve real recheck evidence"
```

### Task 5: Semantic-safe Correction Generator handoff (`vendorclear`)

**Files:**

- Modify: `src/lib/correction/types.ts`
- Modify: `src/lib/correction/options.ts`
- Modify: `src/lib/correction/engine.ts`
- Modify: `src/lib/correction/fromScan.ts`
- Modify: `src/pages/CoiCorrectionGenerator.tsx`
- Test: `src/test/correction-engine.test.ts`
- Test: `src/test/correction-generator.test.tsx`

**Interfaces:**

- Consumes: exact `Finding.status`, evidence state, requirements, and extracted values.
- Produces: new issue types `gl_missing`, `gl_limit_unreadable`, `auto_limit_unreadable`, `policy_dates_unreadable`, `policy_effective_in_future`, `certificate_holder_unreadable`, and `supporting_endorsement_ambiguous`.

- [ ] **Step 1: Write failing semantic mapping tests**

```ts
it.each([
  ["general_liability", "could_not_determine", "gl_limit_unreadable"],
  ["policy_dates", "could_not_determine", "policy_dates_unreadable"],
  ["policy_dates", "needs_review", "policy_effective_in_future"],
  ["certificate_holder", "could_not_determine", "certificate_holder_unreadable"],
  ["auto_liability", "could_not_determine", "auto_limit_unreadable"],
])("maps %s %s without inventing a deficiency", (key, status, issue) => {
  expect(prefillFor(finding(key, status)).issues[0]?.type).toBe(issue);
});
```

Test that wording-only endorsement creates a documentation request and ambiguous form requests legible/form confirmation rather than claiming the endorsement is absent.

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run src/test/correction-engine.test.ts src/test/correction-generator.test.tsx`

Expected: FAIL because uncertainty-specific types/copy do not exist.

- [ ] **Step 3: Implement explicit status-to-issue mapping**

```ts
if (f.key === "general_liability") {
  if (f.status === "below_requirement") return issue("gl_limit_low", limits);
  if (f.status === "not_found") return issue("gl_missing");
  return issue("gl_limit_unreadable");
}
```

Implement similarly explicit branches for dates, holder, auto, workers compensation, and endorsements. Add generator lines that ask for clarification/supporting documentation without unsupported factual claims.

- [ ] **Step 4: Run GREEN tests and commit Task 5**

Run: `bunx vitest run src/test/correction-engine.test.ts src/test/correction-generator.test.tsx`

Expected: all pass.

```powershell
git add src/lib/correction src/pages/CoiCorrectionGenerator.tsx src/test/correction-engine.test.ts src/test/correction-generator.test.tsx
git commit -m "fix: preserve scanner uncertainty in correction requests"
```

### Task 6: Active re-check state, parser provenance, and report lineage (`vendorclear`)

**Files:**

- Modify: `src/pages/CoiScanner.tsx`
- Modify: `src/lib/scanner-report.ts`
- Modify: `src/lib/scanner-storage.ts`
- Modify: `src/components/scanner/FixItReport.tsx`
- Test: `src/test/coi-scanner.test.tsx`
- Test: `src/test/scanner-storage.test.ts`

**Interfaces:**

- Consumes: Task 3 parser metadata/run ID, Task 4 current re-check result, Task 5 correction prefill.
- Produces: current-action `activeResult`, immutable root result, and parent/root/sequence report inserts.

- [ ] **Step 1: Write failing active-result and lineage tests**

```ts
it("prefills only the current re-check issue", async () => {
  await reachRecheckWithOneRemainingIssue();
  fireEvent.click(screen.getByRole("button", { name: /create correction request/i }));
  expect(loadCorrectionPrefill()?.issues).toHaveLength(1);
});

it("creates a parent-linked three-report chain", async () => {
  expect(await saveOriginal()).toMatchObject({ sequenceNumber: 0, recheckOf: null });
  expect(await saveNext("report-a", "report-a", 1)).toMatchObject({
    recheckOf: "report-a",
    rootReportId: "report-a",
  });
  expect(await saveNext("report-b", "report-a", 2)).toMatchObject({
    recheckOf: "report-b",
    rootReportId: "report-a",
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run src/test/coi-scanner.test.tsx src/test/scanner-storage.test.ts`

Expected: FAIL because original results still drive current actions and report IDs are not retained.

- [ ] **Step 3: Implement current/root state separation**

```ts
const activeResult = recheck?.result ?? result;
const activeOpenCount = activeResult.findings.filter((finding) => !isPass(finding)).length;
```

Use `activeResult` for summary/findings/action plan/report/correction CTA/prefill. Keep `result` for root comparison and history. Store active file and compare each new re-check against the previous active result.

- [ ] **Step 4: Implement awaited lineage persistence**

Track `rootReportIdRef`, `latestReportIdRef`, and `reportSequenceRef`. Await the original report insert before enabling unlocked re-check actions. Pass explicit lineage and parser metadata to `saveScannerReport`.

- [ ] **Step 5: Run GREEN tests and commit Task 6**

Run: `bunx vitest run src/test/coi-scanner.test.tsx src/test/scanner-storage.test.ts src/test/correction-engine.test.ts`

Expected: all pass.

```powershell
git add src/pages/CoiScanner.tsx src/lib/scanner-report.ts src/lib/scanner-storage.ts src/components/scanner/FixItReport.tsx src/test
git commit -m "feat: make recheck results current and preserve lineage"
```

### Task 7: Forward-only scanner provenance/feedback migration and secure endpoint (`vendorclear`)

**Files:**

- Create via CLI: the timestamped migration returned by `bunx supabase migration new scanner_parser_provenance_feedback`
- Create: `supabase/functions/submit-scanner-feedback/index.ts`
- Create: `src/test/scanner-feedback.test.ts`
- Modify: `supabase/config.toml`
- Modify: `src/lib/scanner-storage.ts`
- Test cross-repo: `vendorclr-dash/supabase/tests/scanner-parser-feedback.test.ts`

**Interfaces:**

- Consumes: parser run ID/metadata and scanner report lineage.
- Produces: `scanner_parser_runs`, `scanner_parser_feedback`, private bucket `scanner-parser-feedback`, provenance columns, and `submitParserFeedback(formData)`.

- [ ] **Step 1: Discover the current CLI and create the migration file**

Run: `bunx supabase --version`

Run: `bunx supabase migration new scanner_parser_provenance_feedback`

Expected: a new timestamped migration file is created; no existing migration changes.

- [ ] **Step 2: Write failing database/security tests**

```ts
it("denies anonymous feedback reads and direct writes", async () => {
  await db.exec("set local role anon");
  expect((await db.query("select * from public.scanner_parser_feedback")).rows).toEqual([]);
  await expect(
    db.query(`insert into public.scanner_parser_feedback
    (parser_run_id, response, original_extraction, parser_metadata, verified_status, retention_consent)
    values ('00000000-0000-0000-0000-000000000001', 'looks_correct', '{}', '{}', 'pending', false)`),
  ).rejects.toThrow();
});

it("rejects anonymous verification even when the feedback id is known", async () => {
  await db.exec("set local role anon");
  await expect(
    db.exec(
      `update public.scanner_parser_feedback set verified_status='verified' where id='${feedbackId}'`,
    ),
  ).rejects.toThrow();
});
```

Add FK/sequence tests and platform-admin select tests. The cross-repo test reads the migration using `VENDORCLEAR_REPO_DIR` and applies it after the dashboard migration chain.

- [ ] **Step 3: Run database tests and verify RED**

Run from dashboard with `VENDORCLEAR_REPO_DIR=../vendorclear-coi-scanner-hardening`: `bunx vitest run --config vitest.db.config.ts supabase/tests/scanner-parser-feedback.test.ts`

Expected: FAIL because tables/columns/policies do not exist.

- [ ] **Step 4: Implement the migration**

Create append-only parser-run and feedback tables with RLS enabled, no anon table grants, platform-admin SELECT only, private storage bucket configuration, explicit indexes/FKs/check constraints, and provenance/lineage columns. Add report lineage FK constraints without modifying historical rows.

- [ ] **Step 5: Write failing endpoint tests**

```ts
it.each([
  [true, null, "consent_requires_file"],
  [true, oversizedPdf(), "file_too_large"],
  [true, textFile(), "unsupported_type"],
])("does not retain invalid consent uploads", async (consent, file, code) => {
  const response = await submitFixture({ consent, file });
  expect(response.code).toBe(code);
  expect(storageUpload).not.toHaveBeenCalled();
});
```

Also test server-derived diffs, canonical-schema rejection, rate-limit failure, no-consent no-upload, and insert cleanup if storage/database steps fail.

- [ ] **Step 6: Implement the public feedback endpoint**

The function accepts multipart payload plus an optional consented file, revalidates corrected canonical extraction, loads the server-owned parser run, derives diffs, enforces separate limits, uploads only consented valid files to a private bucket, and writes a pending row with the service role. It returns only `{ id, status: "pending" }`.

- [ ] **Step 7: Run endpoint/database tests and commit Task 7 in both repositories**

Run: `bunx vitest run src/test/scanner-feedback.test.ts`

Run from dashboard: `$env:VENDORCLEAR_REPO_DIR='../vendorclear-coi-scanner-hardening'; bun run db:verify`

Expected: all feedback and existing database tests pass.

```powershell
# vendorclear
git add supabase src/lib/scanner-storage.ts src/test/scanner-feedback.test.ts
git commit -m "feat: persist private scanner parser feedback"

# vendorclr-dash
git add supabase/tests/scanner-parser-feedback.test.ts
git commit -m "test: verify free scanner feedback security"
```

### Task 8: Public feedback UX with separate retention consent (`vendorclear`)

**Files:**

- Create: `src/components/scanner/ParserFeedback.tsx`
- Create: `src/lib/scanner-feedback.ts`
- Modify: `src/pages/CoiScanner.tsx`
- Test: `src/test/scanner-feedback-ui.test.tsx`

**Interfaces:**

- Consumes: active real scan, canonical extraction, active file, parser run ID, and Task 7 endpoint.
- Produces: `buildCorrectedExtraction(original, edits)` and consent-aware feedback submissions.

- [ ] **Step 1: Write failing feedback UX tests**

```tsx
it("submits looks-correct without declaring ground truth or retaining a file", async () => {
  renderFeedback(realScan());
  await user.click(screen.getByRole("button", { name: /yes, looks correct/i }));
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ response: "looks_correct", retainDocumentConsent: false }),
  );
});

it("keeps parser-retention consent separate and unchecked", async () => {
  renderFeedback(realScan());
  await user.click(screen.getByRole("button", { name: /something was read incorrectly/i }));
  expect(screen.getByRole("checkbox", { name: /retain this document/i })).not.toBeChecked();
});
```

Test representative edits for insured, producer/carrier, policy number, dates, GL/auto/WC values, holder, endorsement flags/forms, and absence in sample mode.

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run src/test/scanner-feedback-ui.test.tsx`

Expected: FAIL because feedback component/helpers do not exist.

- [ ] **Step 3: Implement structured correction helpers and compact UI**

Use canonical schema parsing before submit. Do not allow edits to parser metadata, run IDs, verification status, or server-derived diffs. Show the retention checkbox only for real files and explain default deletion.

- [ ] **Step 4: Integrate with current result/file**

Render feedback for `analysisMode === "service"` only. Pass the active re-check file when the active result is a re-check. Newsletter consent remains owned by `FixItGate` and is never reused.

- [ ] **Step 5: Run GREEN tests and commit Task 8**

Run: `bunx vitest run src/test/scanner-feedback-ui.test.tsx src/test/coi-scanner.test.tsx`

Expected: all pass.

```powershell
git add src/components/scanner/ParserFeedback.tsx src/lib/scanner-feedback.ts src/pages/CoiScanner.tsx src/test
git commit -m "feat: collect conservative scanner parser feedback"
```

### Task 9: Verified scanner feedback to golden-case capture (`vendorclr-dash`)

**Files:**

- Modify: `scripts/capture-golden-cases.ts`
- Modify: `evals/coi-extraction/README.md`
- Test: `src/tests/capture-golden-cases.test.ts`

**Interfaces:**

- Consumes: verified scanner feedback with retained private source document.
- Produces: scanner-sourced cases in the existing `document.*`, `expected.json`, `provenance.json` layout.

- [ ] **Step 1: Write failing capture-selection tests**

```ts
it("selects only verified feedback with retained source documents", () => {
  expect(selectEligibleScannerFeedback(rows).map((row) => row.id)).toEqual(["verified-with-file"]);
});

it("records scanner provenance without treating anonymous feedback as reviewer truth", () => {
  expect(buildScannerProvenance(row)).toMatchObject({
    source: "scanner_feedback",
    verifiedBy: row.verified_by,
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bunx vitest run src/tests/capture-golden-cases.test.ts`

Expected: FAIL because the script only captures reviewer edits.

- [ ] **Step 3: Add the scanner-feedback adapter**

Add `--source=reviewer|scanner|all`, query only `verified`, require non-null retained object path and verifier, validate corrected extraction with the canonical schema, download from the private bucket using service credentials, and write provenance including parser fingerprint/report/feedback/consent identifiers.

- [ ] **Step 4: Run GREEN tests and commit Task 9**

Run: `bunx vitest run src/tests/capture-golden-cases.test.ts src/tests/coi-parser-contract.test.ts`

Expected: all pass.

```powershell
git add scripts/capture-golden-cases.ts evals/coi-extraction/README.md src/tests/capture-golden-cases.test.ts
git commit -m "feat: capture verified scanner feedback as eval cases"
```

### Task 10: Cross-repository drift CI, full pipeline regression, and delivery

**Files:**

- Create: `vendorclear/.github/workflows/parser-contract-drift.yml`
- Modify: `vendorclr-dash/.github/workflows/ci.yml`
- Modify: `vendorclear/src/test/requirements-builder.test.tsx`
- Modify: `vendorclear/src/test/coi-scanner.test.tsx`
- Modify: `vendorclear/src/test/correction-generator.test.tsx`
- Modify: relevant README/operations documentation in both repositories.

**Interfaces:**

- Consumes: every prior task.
- Produces: blocking drift checks, complete Builder -> Scanner -> Generator coverage, two verified branches, and coordinated PRs to `main`.

- [ ] **Step 1: Add a failing complete-pipeline test**

```tsx
it("carries requirements through the current scan into one-issue correction output", async () => {
  const requirements = buildRequirements();
  const original = scanWithFiveIssues(requirements);
  const current = recheckWithOneIssue(original);
  expect(
    generateCorrection(correctionPrefillFromScan(current) as CorrectionInput)?.checklist,
  ).toHaveLength(1);
});
```

- [ ] **Step 2: Add blocking drift workflows**

The dashboard CI runs its local contract check. The marketing workflow checks out `anthony-tnguyen/vendorclr-dash`, accepts an optional paired SHA for manual dispatch, runs generation in check mode against the marketing checkout, and runs parser behavior fixtures. Default push/PR checks compare with dashboard `main`.

- [ ] **Step 3: Run focused integration tests**

Run in `vendorclear`: `bunx vitest run src/test/requirements-builder.test.tsx src/test/coi-scanner.test.tsx src/test/correction-generator.test.tsx src/test/scanner-parser.test.ts src/test/scanner-feedback-ui.test.tsx`

Run in `vendorclr-dash`: `bunx vitest run src/tests/coi-parser-contract.test.ts src/tests/document-extraction.test.ts src/tests/capture-golden-cases.test.ts`

Expected: all pass.

- [ ] **Step 4: Run full verification in `vendorclear`**

Run: `bun run test`

Run: `bunx tsc --noEmit`

Run: `bun run lint`

Run: `bun run build`

Run: `git diff --check origin/main...HEAD`

Expected: all exit 0; build includes client, SSR, and prerender.

- [ ] **Step 5: Run full verification in `vendorclr-dash`**

Run: `bun run test`

Run: `bun run db:verify` with `VENDORCLEAR_REPO_DIR` set to the sibling worktree.

Run: `bun run typecheck`

Run: `bun run lint`

Run: `bun run format:check`

Run: `bun run build`

Run: `bun run check:coi-parser-contract -- --vendorclear-dir ../vendorclear-coi-scanner-hardening`

Run: `git diff --check origin/main...HEAD`

Expected: all exit 0. If the known vendor-import timeout recurs only under the full parallel suite, reproduce it in isolation and report both results without hiding the full-suite failure.

- [ ] **Step 6: Commit final CI/docs changes**

```powershell
# each repository
git add .github docs README.md src/test src/tests package.json
git commit -m "ci: enforce COI parser contract parity"
```

- [ ] **Step 7: Inspect branch diffs and create coordinated PRs**

Run in each repository: `git status --short --branch` and `git diff --stat origin/main...HEAD`.

Push `feat/coi-parser-contract` and `fix/coi-scanner-hardening`, create non-draft PRs against `main`, attach both PRs to the task, and include test evidence plus manual production actions. Do not deploy functions, apply hosted migrations, create buckets manually, or run a live Anthropic parse unless separately authorized.
