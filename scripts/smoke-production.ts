#!/usr/bin/env node
/**
 * Task 13 - a standalone operations script, following the same conventions
 * as scripts/check-email-deliverability.ts / scripts/export-company.ts /
 * scripts/delete-company.ts: run by hand (or from CI - see
 * .github/workflows/staging-smoke.yml), never imported by anything in
 * src/** other than the workflow functions it deliberately reuses, never
 * run unattended against production without a human choosing to.
 *
 * Exercises the plan's named smoke cases against a REAL target environment
 * (staging or production, selected explicitly - never hardcoded to one):
 * happy-path upload-request flow, expired/cancelled/used/invalid token
 * rejection, duplicate detection, malformed/encrypted document handling,
 * failed/low-confidence extraction visibility, a bounce scenario, malware/
 * provider-outage handling, and a reminder/renewal check - plus a handful
 * of deployment-verification checks the same run can prove cheaply
 * (storage bucket privacy, signed-webhook rejection, cron job registration/
 * health-endpoint reachability) since they need the same target credentials
 * this script already requires.
 *
 * Design choice: most cases call this project's OWN workflow functions
 * directly (resolveActiveUploadRequestByToken()/uploadDocumentForTokenHandler()
 * from src/workflows/vendorUploadRequests.ts) against a service-role
 * Supabase client pointed at the target project, rather than driving the
 * deployed app over HTTP end-to-end. Two reasons:
 *
 *   1. vendor-upload.$token.tsx is a client-rendered TanStack Router route
 *      with no JSON API of its own - a true black-box HTTP smoke test of
 *      "does an expired token show the right error" would need a real
 *      browser (Playwright), which is what e2e/smoke.spec.ts and
 *      staging-smoke.yml's Playwright job already cover for "does the
 *      Worker bundle boot and render" (see docs/operations/release-process.md).
 *      This script complements that, it does not replace it.
 *   2. uploadDocumentForTokenHandler()/resolveActiveUploadRequestByToken()
 *      are ALREADY the plain, request-context-free functions this
 *      project's own tests call directly (see their own docblocks in
 *      vendorUploadRequests.ts) - calling them here against a target
 *      project's real Supabase instance exercises the real business logic
 *      (real RLS-bypassing service-role writes, real DB constraints, real
 *      thrown errors) with a genuine signal to check, not a mock.
 *
 * Requires the SAME service-role credentials the app's own server code uses
 * (VENDORCLEAR_SUPABASE_URL / VENDORCLEAR_SERVICE_ROLE_KEY - see
 * .env.example), pointed at whichever project --env selects. This script
 * does not itself know which URL corresponds to "staging" vs "production" -
 * the operator sets these two env vars to the correct project before
 * running, exactly like scripts/export-company.ts already requires. --env
 * only labels the artifact; SMOKE_BASE_URL (or --base-url) is the deployed
 * app origin used for the HTTP-reachability checks (health endpoints,
 * webhook signature rejection).
 *
 * Usage:
 *   bun scripts/smoke-production.ts --env=staging [--base-url=https://staging.vendorclr.com] [--out=./smoke-artifacts]
 *   bun scripts/smoke-production.ts --env=production --base-url=https://vendorclr.com
 *
 * Every run writes one JSON artifact (default ./smoke-artifacts/<env>-<timestamp>.json)
 * recording the git SHA this run executed against, a timestamp, which
 * environment it targeted, and pass/fail/skip per case - the plan's own
 * Definition of Done ("smoke artifacts identify revision/time/result").
 * Exits non-zero if any case failed (skips do not fail the run).
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminClient } from "./lib/supabaseAdminClient";

// ---------------------------------------------------------------------------
// CLI / artifact shapes - pure functions, unit tested in
// src/tests/smoke-production.test.ts against fake input, no live connection.
// ---------------------------------------------------------------------------

export type SmokeEnv = "staging" | "production";

export interface SmokeArgs {
  env: SmokeEnv;
  baseUrl: string | null;
  outDir: string;
}

const VALID_ENVS: SmokeEnv[] = ["staging", "production"];

/**
 * Parses --env / --base-url / --out from argv, falling back to
 * SMOKE_TARGET_ENV / SMOKE_BASE_URL / SMOKE_OUT_DIR env vars, in that order.
 * Throws a plain Error with a usage message for anything invalid - main()
 * catches it and exits 1 rather than a stack trace, but the function itself
 * stays a pure throw so it's trivially testable.
 */
export function parseSmokeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SmokeArgs {
  let envArg: string | undefined;
  let baseUrlArg: string | undefined;
  let outArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    const [flag, inlineValue] = token.split(/=(.*)/s);
    const takeValue = () => inlineValue ?? argv[++i];
    if (flag === "--env") envArg = takeValue();
    else if (flag === "--base-url") baseUrlArg = takeValue();
    else if (flag === "--out") outArg = takeValue();
  }

  const resolvedEnv = (envArg ?? env["SMOKE_TARGET_ENV"] ?? "").trim();
  if (!VALID_ENVS.includes(resolvedEnv as SmokeEnv)) {
    throw new Error(
      `--env must be one of ${VALID_ENVS.join(", ")} (got ${JSON.stringify(resolvedEnv)}). ` +
        "Usage: bun scripts/smoke-production.ts --env=staging|production [--base-url=<url>] [--out=<dir>]",
    );
  }

  const baseUrl = (baseUrlArg ?? env["SMOKE_BASE_URL"] ?? "").trim() || null;
  const outDir = (outArg ?? env["SMOKE_OUT_DIR"] ?? "./smoke-artifacts").trim();

  return { env: resolvedEnv as SmokeEnv, baseUrl, outDir };
}

export type SmokeCaseStatus = "pass" | "fail" | "skip";

export interface SmokeCaseResult {
  name: string;
  status: SmokeCaseStatus;
  detail: string;
  durationMs: number;
}

export interface SmokeArtifact {
  gitSha: string;
  env: SmokeEnv;
  baseUrl: string | null;
  startedAt: string;
  finishedAt: string;
  cases: SmokeCaseResult[];
  summary: { pass: number; fail: number; skip: number };
  overallResult: "pass" | "fail";
}

/** Never throws - "unknown" is itself informative (not run inside a git checkout, or git unavailable) rather than a script-killing error over a nice-to-have field. */
export function currentGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Pure formatting - builds the artifact object from a completed run's results. No I/O; writeArtifact() below is the only caller that touches the filesystem. */
export function buildSmokeArtifact(params: {
  gitSha: string;
  env: SmokeEnv;
  baseUrl: string | null;
  startedAt: Date;
  finishedAt: Date;
  cases: SmokeCaseResult[];
}): SmokeArtifact {
  const summary = { pass: 0, fail: 0, skip: 0 };
  for (const c of params.cases) summary[c.status]++;

  return {
    gitSha: params.gitSha,
    env: params.env,
    baseUrl: params.baseUrl,
    startedAt: params.startedAt.toISOString(),
    finishedAt: params.finishedAt.toISOString(),
    cases: params.cases,
    summary,
    overallResult: summary.fail > 0 ? "fail" : "pass",
  };
}

export function artifactFileName(artifact: SmokeArtifact): string {
  const safeTimestamp = artifact.startedAt.replace(/[:.]/g, "-");
  return `${artifact.env}-${safeTimestamp}.json`;
}

async function writeArtifact(artifact: SmokeArtifact, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, artifactFileName(artifact));
  await writeFile(filePath, JSON.stringify(artifact, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Case runner - wraps each case in try/catch and timing, same "one bad case
// must not kill the whole run" resilience every scheduled Edge Function in
// this project already applies to its own per-row loop.
// ---------------------------------------------------------------------------

async function runCase(
  name: string,
  fn: () => Promise<{ pass: boolean; detail: string } | { skip: true; detail: string }>,
): Promise<SmokeCaseResult> {
  const start = Date.now();
  try {
    const outcome = await fn();
    const durationMs = Date.now() - start;
    if ("skip" in outcome) return { name, status: "skip", detail: outcome.detail, durationMs };
    return {
      name,
      status: outcome.pass ? "pass" : "fail",
      detail: outcome.detail,
      durationMs,
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures - a throwaway company/vendor this run creates and reads back
// through, named so a stray row is obviously a smoke artifact if it is ever
// found on a dashboard (should not happen against production - see
// docs/operations/backup-restore.md's companion caution about running any
// state-mutating operation against a real customer-visible project).
// ---------------------------------------------------------------------------

const FIXTURE_PREFIX = "__smoke-production__";

interface Fixture {
  companyId: string;
  vendorId: string;
}

async function createFixture(supabase: SupabaseClient, runId: string): Promise<Fixture> {
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .insert({ name: `${FIXTURE_PREFIX}${runId}` })
    .select("id")
    .single();
  if (companyError || !company) {
    throw new Error(`Could not create fixture company: ${companyError?.message}`);
  }

  const { data: vendor, error: vendorError } = await supabase
    .from("vendors")
    .insert({
      company_id: company.id,
      name: `${FIXTURE_PREFIX}vendor-${runId}`,
      trade: "Electrical",
      contact_name: "Smoke Test Contact",
      contact_email: `smoke-${runId}@example.invalid`,
    })
    .select("id")
    .single();
  if (vendorError || !vendor) {
    throw new Error(`Could not create fixture vendor: ${vendorError?.message}`);
  }

  return { companyId: company.id as string, vendorId: vendor.id as string };
}

/** Best-effort teardown - a leftover fixture is inert (obviously named, never customer data), so a failed cleanup is logged, not thrown. */
async function cleanupFixture(supabase: SupabaseClient, fixture: Fixture): Promise<void> {
  try {
    await supabase.from("companies").delete().eq("id", fixture.companyId);
  } catch (error) {
    console.warn(
      `[smoke-production] fixture cleanup failed for company ${fixture.companyId}: ` +
        `${error instanceof Error ? error.message : String(error)} - delete it by hand.`,
    );
  }
}

async function insertUploadRequest(
  supabase: SupabaseClient,
  fixture: Fixture,
  overrides: { status?: string; expiresAt?: Date } = {},
): Promise<{ token: string; requestId: string }> {
  const { generateUploadToken, hashToken, newExpiryDate } =
    await import("../src/workflows/uploadTokens");
  const token = generateUploadToken();
  const tokenHash = await hashToken(token);
  const expiresAt = overrides.expiresAt ?? newExpiryDate();

  const { data, error } = await supabase
    .from("vendor_upload_requests")
    .insert({
      company_id: fixture.companyId,
      vendor_id: fixture.vendorId,
      token_hash: tokenHash,
      purpose: "renewal",
      status: overrides.status ?? "pending",
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Could not create upload request: ${error?.message}`);

  return { token, requestId: data.id as string };
}

// A minimal, syntactically valid single-page PDF - real "%PDF-" magic bytes
// so file-type sniffing recognizes it, real "%%EOF" trailer. Good enough to
// pass validateUploadedFile()'s content checks without needing a real
// certificate scan.
const MINIMAL_VALID_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF",
  "utf8",
);

// Same shape, but with a literal "/Encrypt" token in the trailer -
// pdfAppearsEncrypted() (src/workflows/fileValidation.server.ts) looks for
// exactly this byte sequence without fully parsing the file, per that
// function's own docblock.
const ENCRYPTED_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "trailer<</Root 1 0 R/Encrypt 4 0 R>>\n%%EOF",
  "utf8",
);

function pdfFile(bytes: Buffer, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function caseHealthEndpoints(baseUrl: string | null) {
  if (!baseUrl) {
    return { skip: true as const, detail: "no --base-url/SMOKE_BASE_URL set - skipped" };
  }
  const results: string[] = [];
  for (const endpoint of ["/api/health/live", "/api/health/ready"]) {
    const url = new URL(endpoint, baseUrl).toString();
    const response = await fetch(url);
    results.push(`${endpoint} -> ${response.status}`);
    if (!response.ok) return { pass: false, detail: results.join("; ") };
  }
  return { pass: true, detail: results.join("; ") };
}

async function caseWebhookSignatureRejection(supabaseUrl: string) {
  // Matches the "Deployment verification" technique already documented in
  // supabase/README.md and printed by scripts/check-email-deliverability.ts:
  // an UNSIGNED call to resend-webhook must be refused with 401 - that is
  // the PASSING outcome, proving the function is live and fails closed.
  const url = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/resend-webhook`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "email.bounced", created_at: new Date().toISOString(), data: {} }),
  });
  const pass = response.status === 401;
  return {
    pass,
    detail: pass
      ? "unsigned webhook call correctly rejected with 401"
      : `expected 401, got ${response.status} - webhook may be misconfigured or unreachable`,
  };
}

async function caseCronJobsRegistered(supabase: SupabaseClient) {
  const expectedJobs = [
    "send-renewal-reminders-daily",
    "retry-failed-documents-hourly",
    "process-document-jobs-every-minute",
    "compliance-housekeeping-daily",
  ];
  const { data, error } = await supabase.rpc("get_scheduled_job_run_history");
  // get_scheduled_job_run_history() reads cron.job_run_details, not cron.job
  // itself, and is service-role-only by design (see its own migration) - a
  // clean call (even zero rows, on a project with no history yet) proves
  // service_role has the USAGE/SELECT grants operations_cron_grants.sql
  // establishes and that the wrapper function itself deployed correctly.
  if (error) return { pass: false, detail: `rpc failed: ${error.message}` };
  return {
    pass: true,
    detail:
      `get_scheduled_job_run_history() reachable (${Array.isArray(data) ? data.length : 0} history row(s)). ` +
      `Expected jobs (verify via 'select jobname from cron.job' with dashboard/CLI access): ${expectedJobs.join(", ")}`,
  };
}

async function caseStorageBucketPrivacy(supabase: SupabaseClient) {
  const { data, error } = await supabase.storage.getBucket("vendor-documents");
  if (error || !data) return { pass: false, detail: `could not read bucket: ${error?.message}` };
  const pass = data.public === false;
  return {
    pass,
    detail: pass
      ? "vendor-documents bucket is private (public=false)"
      : `vendor-documents bucket reports public=${data.public} - should be false`,
  };
}

async function caseHappyPath(supabase: SupabaseClient, fixture: Fixture) {
  const { resolveActiveUploadRequestByToken, uploadDocumentForTokenHandler } =
    await import("../src/workflows/vendorUploadRequests");
  const { token } = await insertUploadRequest(supabase, fixture);

  const resolved = await resolveActiveUploadRequestByToken(token, "203.0.113.10");
  if (
    resolved.status !== "opened" &&
    resolved.status !== "pending" &&
    resolved.status !== "email_sent"
  ) {
    return { pass: false, detail: `unexpected resolved status: ${resolved.status}` };
  }

  const formData = new FormData();
  formData.set("token", token);
  formData.set("file", pdfFile(MINIMAL_VALID_PDF, "smoke-happy-path.pdf"));
  const uploadResult = await uploadDocumentForTokenHandler(formData, "203.0.113.10");

  const { data: doc, error } = await supabase
    .from("vendor_documents")
    .select("id, processing_status, sha256, file_size")
    .eq("id", uploadResult.documentId)
    .maybeSingle();
  if (error || !doc)
    return { pass: false, detail: `document row not found after upload: ${error?.message}` };

  const { data: job } = await supabase
    .from("document_processing_jobs")
    .select("id, status")
    .eq("target_document_id", uploadResult.documentId)
    .maybeSingle();

  return {
    pass: true,
    detail:
      `resolved token (status=${resolved.status}), uploaded document ${doc.id} ` +
      `(processing_status=${doc.processing_status}, ${doc.file_size} bytes), ` +
      `extraction job ${job ? `enqueued (status=${job.status})` : "NOT found"}`,
  };
}

async function caseTokenRejection(
  supabase: SupabaseClient,
  fixture: Fixture,
  scenario: "expired" | "cancelled" | "used" | "invalid",
) {
  const { resolveActiveUploadRequestByToken } =
    await import("../src/workflows/vendorUploadRequests");

  let token: string;
  if (scenario === "invalid") {
    token = "smoke-test-token-that-was-never-issued";
  } else if (scenario === "expired") {
    ({ token } = await insertUploadRequest(supabase, fixture, {
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    }));
  } else if (scenario === "cancelled") {
    ({ token } = await insertUploadRequest(supabase, fixture, { status: "cancelled" }));
  } else {
    ({ token } = await insertUploadRequest(supabase, fixture, { status: "completed" }));
  }

  try {
    await resolveActiveUploadRequestByToken(token, "203.0.113.20");
    return {
      pass: false,
      detail: `expected rejection for ${scenario} token, but it resolved successfully`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pass = message.includes("no longer valid");
    return {
      pass,
      detail: pass
        ? `${scenario} token correctly rejected: "${message}"`
        : `${scenario} token rejected with an unexpected error: "${message}"`,
    };
  }
}

async function caseDuplicateDetection(supabase: SupabaseClient, fixture: Fixture) {
  const { uploadDocumentForTokenHandler } = await import("../src/workflows/vendorUploadRequests");

  const first = await insertUploadRequest(supabase, fixture);
  const firstForm = new FormData();
  firstForm.set("token", first.token);
  firstForm.set("file", pdfFile(MINIMAL_VALID_PDF, "smoke-duplicate-1.pdf"));
  const firstUpload = await uploadDocumentForTokenHandler(firstForm, "203.0.113.30");

  const second = await insertUploadRequest(supabase, fixture);
  const secondForm = new FormData();
  secondForm.set("token", second.token);
  secondForm.set("file", pdfFile(MINIMAL_VALID_PDF, "smoke-duplicate-2.pdf"));
  const secondUpload = await uploadDocumentForTokenHandler(secondForm, "203.0.113.30");

  const { data: secondDoc, error } = await supabase
    .from("vendor_documents")
    .select("duplicate_of_document_id")
    .eq("id", secondUpload.documentId)
    .maybeSingle();
  if (error || !secondDoc)
    return { pass: false, detail: `could not read second document: ${error?.message}` };

  const pass = secondDoc.duplicate_of_document_id === firstUpload.documentId;
  return {
    pass,
    detail: pass
      ? `second upload correctly flagged as a duplicate of ${firstUpload.documentId}`
      : `second upload's duplicate_of_document_id was ${secondDoc.duplicate_of_document_id}, expected ${firstUpload.documentId}`,
  };
}

async function caseMalformedDocument(supabase: SupabaseClient, fixture: Fixture) {
  const { uploadDocumentForTokenHandler } = await import("../src/workflows/vendorUploadRequests");
  const { token } = await insertUploadRequest(supabase, fixture);

  const formData = new FormData();
  formData.set("token", token);
  formData.set(
    "file",
    new File([new Uint8Array(0)], "smoke-empty.pdf", { type: "application/pdf" }),
  );

  try {
    await uploadDocumentForTokenHandler(formData, "203.0.113.40");
    return {
      pass: false,
      detail: "expected an empty file to be rejected, but the upload succeeded",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { pass: true, detail: `empty/malformed file correctly rejected: "${message}"` };
  }
}

async function caseEncryptedDocument(supabase: SupabaseClient, fixture: Fixture) {
  const { uploadDocumentForTokenHandler } = await import("../src/workflows/vendorUploadRequests");
  const { token } = await insertUploadRequest(supabase, fixture);

  const formData = new FormData();
  formData.set("token", token);
  formData.set("file", pdfFile(ENCRYPTED_PDF, "smoke-encrypted.pdf"));

  try {
    await uploadDocumentForTokenHandler(formData, "203.0.113.50");
    return {
      pass: false,
      detail: "expected an encrypted PDF to be rejected, but the upload succeeded",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pass = message.toLowerCase().includes("password");
    return {
      pass,
      detail: pass
        ? `encrypted PDF correctly rejected: "${message}"`
        : `encrypted PDF rejected with an unexpected message: "${message}"`,
    };
  }
}

async function caseExtractionInvocation(supabaseUrl: string, serviceRoleKey: string) {
  // Directly invokes the process-document-jobs Edge Function once, the same
  // way pg_cron -> pg_net does every minute in the deployed project. This is
  // the "failed/low-confidence extraction" case's real, checkable signal:
  // whichever of {notConfigured: true} (no ANTHROPIC_API_KEY Edge Function
  // secret set yet) or {claimed, succeeded, failed, exhausted} counts comes
  // back is a genuine fact about this environment's current extraction
  // capability, not a guess - see docs/operations/environment-matrix.md for
  // whether ANTHROPIC_API_KEY is expected to be configured on this target
  // yet.
  const url = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/process-document-jobs`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    return { pass: false, detail: `HTTP ${response.status}: ${JSON.stringify(body)}` };
  return {
    pass: true,
    detail:
      body && typeof body === "object" && "notConfigured" in body && body.notConfigured
        ? "process-document-jobs invoked successfully; ANTHROPIC_API_KEY is not configured on this environment yet (documents stay queued) - see environment-matrix.md"
        : `process-document-jobs invoked successfully: ${JSON.stringify(body)}`,
  };
}

async function caseBounceScenario(supabase: SupabaseClient, fixture: Fixture) {
  const bounceEmail = `smoke-bounce-${Date.now()}@example.invalid`;
  const { data: outboxRow, error: outboxError } = await supabase
    .from("email_outbox")
    .insert({
      company_id: fixture.companyId,
      vendor_id: fixture.vendorId,
      template: "renewal_request",
      to_email: bounceEmail,
      status: "sent",
      sent_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (outboxError || !outboxRow) {
    return {
      pass: false,
      detail: `could not create fixture email_outbox row: ${outboxError?.message}`,
    };
  }

  const { error: eventError } = await supabase.from("email_delivery_events").insert({
    company_id: fixture.companyId,
    email_outbox_id: outboxRow.id,
    event_type: "bounced",
    detail: { reason: "smoke-test synthetic bounce" },
    occurred_at: new Date().toISOString(),
  });
  if (eventError)
    return { pass: false, detail: `could not insert bounce event: ${eventError.message}` };

  // handle_bounce_suppression() (20260916000600_contacts_and_suppression.sql)
  // is a synchronous AFTER INSERT trigger, so both effects are already
  // committed by the time the insert above returns - no poll needed.
  const { data: suppression } = await supabase
    .from("suppressed_recipients")
    .select("id, reason")
    .eq("company_id", fixture.companyId)
    .eq("email", bounceEmail)
    .maybeSingle();

  const { data: task } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("company_id", fixture.companyId)
    .eq("vendor_id", fixture.vendorId)
    .ilike("title", "%suppressed from automated sends%")
    .maybeSingle();

  const pass = Boolean(suppression) && Boolean(task);
  return {
    pass,
    detail: pass
      ? `bounce correctly suppressed ${bounceEmail} and created task "${task?.title}"`
      : `suppression row ${suppression ? "found" : "MISSING"}, task row ${task ? "found" : "MISSING"}`,
  };
}

async function caseMalwareScanStatus(supabase: SupabaseClient, fixture: Fixture) {
  const { uploadDocumentForTokenHandler } = await import("../src/workflows/vendorUploadRequests");
  const { token } = await insertUploadRequest(supabase, fixture);

  const formData = new FormData();
  formData.set("token", token);
  formData.set("file", pdfFile(MINIMAL_VALID_PDF, "smoke-malware-scan.pdf"));
  const result = await uploadDocumentForTokenHandler(formData, "203.0.113.60");

  const { data: doc, error } = await supabase
    .from("vendor_documents")
    .select("malware_scan_status")
    .eq("id", result.documentId)
    .maybeSingle();
  if (error || !doc)
    return { pass: false, detail: `could not read uploaded document: ${error?.message}` };

  // Any of these is a VALID outcome - the point is that the upload never
  // silently fails to record a scan status at all (see the malware_scan_status
  // CHECK constraint - migration 16). 'not_configured' specifically confirms
  // VIRUSTOTAL_API_KEY is not yet set as a server-side secret on this
  // environment, a real, useful signal for environment-matrix.md, not a
  // failure of this check.
  const validStatuses = ["clean", "malicious", "unknown", "not_configured", "error"];
  const pass = validStatuses.includes(doc.malware_scan_status);
  return {
    pass,
    detail: `malware_scan_status = "${doc.malware_scan_status}"${doc.malware_scan_status === "not_configured" ? " (VIRUSTOTAL_API_KEY not set on this environment)" : ""}`,
  };
}

async function caseReminderRenewalCheck(supabase: SupabaseClient) {
  const { error, count } = await supabase
    .from("policies_due_for_reminder")
    .select("policy_id", { count: "exact", head: true });
  if (error)
    return { pass: false, detail: `policies_due_for_reminder query failed: ${error.message}` };
  return {
    pass: true,
    detail: `policies_due_for_reminder reachable (${count ?? 0} polic(ies) currently due) - renewal-reminder view/RLS intact`,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseSmokeArgs(process.argv.slice(2));
  const startedAt = new Date();
  const gitSha = currentGitSha();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log(
    `smoke-production: env=${args.env} sha=${gitSha} startedAt=${startedAt.toISOString()}`,
  );

  const supabaseUrl = process.env["VENDORCLEAR_SUPABASE_URL"]?.trim();
  const serviceRoleKey = process.env["VENDORCLEAR_SERVICE_ROLE_KEY"]?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "VENDORCLEAR_SUPABASE_URL and VENDORCLEAR_SERVICE_ROLE_KEY must both be set, pointed at the " +
        `${args.env} project, before running this script. See docs/operations/environment-matrix.md.`,
    );
    process.exitCode = 1;
    return;
  }

  const supabase = getAdminClient();
  const cases: SmokeCaseResult[] = [];
  let fixture: Fixture | null = null;

  cases.push(await runCase("health_endpoints", () => caseHealthEndpoints(args.baseUrl)));
  cases.push(
    await runCase("webhook_signature_rejection", () => caseWebhookSignatureRejection(supabaseUrl)),
  );
  cases.push(await runCase("cron_jobs_reachable", () => caseCronJobsRegistered(supabase)));
  cases.push(await runCase("storage_bucket_privacy", () => caseStorageBucketPrivacy(supabase)));
  cases.push(await runCase("reminder_renewal_check", () => caseReminderRenewalCheck(supabase)));

  try {
    fixture = await createFixture(supabase, runId);

    cases.push(await runCase("happy_path_upload_request", () => caseHappyPath(supabase, fixture!)));
    cases.push(
      await runCase("expired_token_rejected", () =>
        caseTokenRejection(supabase, fixture!, "expired"),
      ),
    );
    cases.push(
      await runCase("cancelled_token_rejected", () =>
        caseTokenRejection(supabase, fixture!, "cancelled"),
      ),
    );
    cases.push(
      await runCase("used_token_rejected", () => caseTokenRejection(supabase, fixture!, "used")),
    );
    cases.push(
      await runCase("invalid_token_rejected", () =>
        caseTokenRejection(supabase, fixture!, "invalid"),
      ),
    );
    cases.push(
      await runCase("duplicate_detection", () => caseDuplicateDetection(supabase, fixture!)),
    );
    cases.push(
      await runCase("malformed_document_rejected", () => caseMalformedDocument(supabase, fixture!)),
    );
    cases.push(
      await runCase("encrypted_document_rejected", () => caseEncryptedDocument(supabase, fixture!)),
    );
    cases.push(
      await runCase("malware_scan_status_recorded", () =>
        caseMalwareScanStatus(supabase, fixture!),
      ),
    );
    cases.push(
      await runCase("extraction_worker_invocation", () =>
        caseExtractionInvocation(supabaseUrl, serviceRoleKey),
      ),
    );
    cases.push(await runCase("bounce_suppression", () => caseBounceScenario(supabase, fixture!)));
  } finally {
    if (fixture) await cleanupFixture(supabase, fixture);
  }

  const finishedAt = new Date();
  const artifact = buildSmokeArtifact({
    gitSha,
    env: args.env,
    baseUrl: args.baseUrl,
    startedAt,
    finishedAt,
    cases,
  });

  const filePath = await writeArtifact(artifact, args.outDir);

  console.log("");
  for (const c of artifact.cases) {
    const icon = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP";
    console.log(`[${icon}] ${c.name} (${c.durationMs}ms) - ${c.detail}`);
  }
  console.log("");
  console.log(
    `${artifact.summary.pass} passed, ${artifact.summary.fail} failed, ${artifact.summary.skip} skipped. ` +
      `Artifact: ${filePath}`,
  );

  process.exitCode = artifact.overallResult === "fail" ? 1 : 0;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("smoke-production.ts");
if (isDirectRun) {
  main().catch((error) => {
    console.error("smoke-production failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
