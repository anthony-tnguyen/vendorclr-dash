import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Loaded lazily inside handlers, same reason as every other workflow module
 * in this project: a static import of the *.server module puts it in the
 * client import graph (this file is imported by React components via
 * createServerFn()'s isomorphic wrapper), which the build's import
 * protection (importProtection.client.files: ["**\/server/**"]) rejects.
 */
async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

import { createUploadRequest } from "./vendorUploadRequests";

/**
 * Task 11a - the bulk CSV vendor/project import pipeline (the import half of
 * the plan's Task 11; reporting/exports/audit-history/metrics are a separate
 * Task 11b, not built here).
 *
 * Three phases, matching the plan's "preview -> validate -> confirm ->
 * execute" (confirm is a UI-only step - the user reviewing validate's output
 * before clicking a button that calls execute; there is no separate
 * "confirm" server function):
 *
 *   previewVendorImport()    - pure, no DB access. Parses the CSV and
 *                               returns a UI-ready preview (columns, row
 *                               count, first few rows). Not wrapped in
 *                               createServerFn(): it needs no server-side
 *                               state at all, matching how this codebase's
 *                               other pure/parse-only logic (e.g.
 *                               complianceEngine.ts) stays a plain export
 *                               rather than a server function.
 *
 *   validateVendorImportRows() - a createServerFn, read-only. For each row:
 *                               validates required fields / email shape /
 *                               trade+risk_tier vocabulary, and predicts
 *                               whether the project/vendor would be created
 *                               fresh or matched to an existing one, using
 *                               the SAME normalization logic import_vendor_
 *                               row()'s SQL lookups use - kept in sync
 *                               DELIBERATELY, and the two are NOT the same
 *                               function: normalizeMatch() (trim+lowercase)
 *                               is for vendor name/email matching, while
 *                               normalizeProjectMatch() (trim only, no
 *                               case-folding) is for project name matching -
 *                               mirroring that projects.name's own `unique
 *                               (company_id, name)` constraint (Task 4) is
 *                               case-sensitive while vendors has no DB-level
 *                               uniqueness constraint to anchor to at all.
 *                               A divergence here is a real data-safety bug,
 *                               not just a UX one: it previously meant
 *                               validate could predict "this project already
 *                               exists" for two differently-cased names that
 *                               the SQL function's case-sensitive comparison
 *                               would NOT match, so execute() would silently
 *                               create a duplicate project row - found by an
 *                               independent spec-compliance review, fixed by
 *                               splitting the two normalization functions.
 *
 *   executeVendorImport()    - a createServerFn, the only phase that writes.
 *                               Checks vendor_import_batches for an existing
 *                               (company_id, idempotency_key) row FIRST and
 *                               returns its stored row_results verbatim if
 *                               found - a retried submission (e.g. after a
 *                               network timeout) is a no-op, never a second
 *                               import. Otherwise re-validates defensively
 *                               (this project's general anti-probing/
 *                               defense-in-depth posture - see e.g.
 *                               sendRequest()'s own re-verification of
 *                               confirmed recipient ids - rather than
 *                               trusting a client-side "confirm" step that
 *                               could be stale or tampered with), then calls
 *                               import_vendor_row() via RPC once per valid
 *                               row (each call is its own implicit
 *                               transaction - a rejected row is never
 *                               attempted at all, so "rejected rows do not
 *                               partially write" holds trivially for them),
 *                               optionally dispatching an upload request for
 *                               the resolved vendor without letting a
 *                               dispatch failure affect that row's already-
 *                               committed core write (or any other row) -
 *                               the same "a downstream notification failure
 *                               doesn't undo an already-committed core
 *                               write" pattern as notifyDocumentOutcome()
 *                               (communications.ts) / Task 8b/9a - then
 *                               writes ONE vendor_import_batches row
 *                               summarizing the whole run, which is what
 *                               makes the next call with the same
 *                               idempotency key short-circuit correctly.
 */

// ---------------------------------------------------------------------------
// Shared vocab - must exactly match vendors.trade / vendors.risk_tier
// (20260901000200_vendor_domain.sql) and project_vendor_assignments.
// trade_code / risk_classification (20260916000300_construction_core_expand.sql).
// That migration's own comment notes the two CHECK sets must agree; this is
// deliberately the SAME list, not a third vocabulary.
// ---------------------------------------------------------------------------

export const TRADE_VALUES = [
  "Structural Steel",
  "Electrical",
  "Mechanical / HVAC",
  "Concrete",
  "Earthwork",
  "Roofing",
  "Glazing",
  "Fire Protection",
] as const;
export type Trade = (typeof TRADE_VALUES)[number];

export const RISK_TIER_VALUES = ["low", "moderate", "high"] as const;
export type RiskTier = (typeof RISK_TIER_VALUES)[number];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase, for VENDOR name/email MATCHING only - never used for what gets stored (import_vendor_row() preserves the row's own casing on insert). */
export function normalizeMatch(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Trim only (no case-folding), for PROJECT name MATCHING only. Deliberately
 * NOT the same as normalizeMatch(): import_vendor_row()'s project lookup
 * compares btrim(name) with no lower() (matching projects' own
 * case-sensitive `unique (company_id, name)` constraint from Task 4 -
 * construction_core_expand.sql), while the vendor lookup below IS
 * case-insensitive by design (a vendor has no DB uniqueness constraint at
 * all to anchor to, so the plan's own "normalized ... vendor/email
 * duplicates" wording is this codebase's only source of truth for vendor
 * matching). Using normalizeMatch() (trim+lowercase) here instead would
 * make this function predict "will match an existing project" for two
 * differently-cased names that the SQL function's case-sensitive
 * comparison would NOT match - producing a duplicate project row that
 * validateVendorImportRows() told the caller would never happen. Found by
 * an independent spec-compliance review; see this file's own header
 * comment for the general "keep the SQL and TS copies of this
 * normalization logic in sync" requirement.
 */
export function normalizeProjectMatch(value: string): string {
  return value.trim();
}

// ---------------------------------------------------------------------------
// previewVendorImport() - pure CSV parsing, no DB access.
// ---------------------------------------------------------------------------

/**
 * Minimal dependency-free CSV parser: handles quoted fields (RFC 4180
 * double-quote escaping via ""), embedded commas and embedded newlines
 * inside quotes, and both \n and \r\n line endings. This repo has no CSV
 * parsing dependency (checked package.json) and generally prefers a small,
 * well-scoped hand-rolled implementation over a new dependency for
 * something this narrow (a handful of well-understood escaping rules) -
 * matching this project's general minimal-dependency preference elsewhere
 * (e.g. uploadTokens.ts's own token generation rather than reaching for a
 * library). Returns raw string rows/fields; no header handling here.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush a trailing field/row that had no closing newline.
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop wholly-blank lines (a single empty field), matching how most
  // spreadsheet exports leave a trailing blank line at end of file.
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

export interface ParsedRow {
  /** 1-based, counting only data rows (the header row is not row 1). */
  rowNumber: number;
  projectName: string;
  certificateHolderName: string;
  certificateHolderAddress: string;
  vendorName: string;
  trade: string;
  contactName: string;
  contactEmail: string;
  riskTier: string;
  contractValue: number | null;
  dispatchRequest: boolean;
}

export const EXPECTED_COLUMNS = [
  "project_name",
  "certificate_holder_name",
  "certificate_holder_address",
  "vendor_name",
  "trade",
  "contact_name",
  "contact_email",
  "risk_tier",
  "contract_value",
  "dispatch_request",
] as const;

function toParsedRow(headers: string[], raw: string[], rowNumber: number): ParsedRow {
  const get = (key: string): string => {
    const idx = headers.indexOf(key);
    return idx === -1 ? "" : (raw[idx] ?? "").trim();
  };
  const contractValueRaw = get("contract_value");
  const dispatchRaw = get("dispatch_request").toLowerCase();
  const contractValue =
    contractValueRaw === "" ? null : Number.parseFloat(contractValueRaw.replace(/,/g, ""));

  return {
    rowNumber,
    projectName: get("project_name"),
    certificateHolderName: get("certificate_holder_name"),
    certificateHolderAddress: get("certificate_holder_address"),
    vendorName: get("vendor_name"),
    trade: get("trade"),
    contactName: get("contact_name"),
    contactEmail: get("contact_email"),
    riskTier: get("risk_tier"),
    contractValue,
    dispatchRequest: dispatchRaw === "true" || dispatchRaw === "1" || dispatchRaw === "yes",
  };
}

/** Parses every data row in the CSV (not just a preview sample) - shared by parseCsv() consumers that need the whole file, e.g. validateVendorImportRows()/executeVendorImport() callers building `rows` client-side. */
export function parseAllRows(csvText: string): ParsedRow[] {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map(normalizeHeader);
  return rows.slice(1).map((raw, idx) => toParsedRow(headers, raw, idx + 1));
}

export interface PreviewResult {
  columns: string[];
  totalRows: number;
  /** First 5 data rows only - a UI preview, not the full parsed set (see parseAllRows() for that). */
  sampleRows: ParsedRow[];
}

/** Pure - no DB access, no createServerFn wrapper needed (see this file's own docblock for why). */
export function previewVendorImport(csvText: string): PreviewResult {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return { columns: [], totalRows: 0, sampleRows: [] };

  const headers = rows[0]!.map(normalizeHeader);
  const parsed = rows.slice(1).map((raw, idx) => toParsedRow(headers, raw, idx + 1));

  return {
    columns: headers,
    totalRows: parsed.length,
    sampleRows: parsed.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Row validation - pure logic shared by validateVendorImportRows() (reads
// live DB state) and executeVendorImport() (re-runs the same logic
// defensively before writing).
// ---------------------------------------------------------------------------

export interface RowValidationError {
  field: string;
  reason: string;
}

export interface ValidatedRow {
  rowNumber: number;
  status: "valid" | "rejected";
  errors: RowValidationError[];
  willCreateProject: boolean;
  willCreateVendor: boolean;
}

export interface RowValidationContext {
  existingProjectNames: Set<string>;
  existingVendorNames: Set<string>;
  existingVendorEmails: Set<string>;
}

export function emptyValidationContext(): RowValidationContext {
  return {
    existingProjectNames: new Set(),
    existingVendorNames: new Set(),
    existingVendorEmails: new Set(),
  };
}

/**
 * Validates a single row against a snapshot of already-known project/vendor
 * names+emails. Does not mutate ctx - validateRows() below folds each valid
 * row's own project/vendor into a working copy before validating the next
 * row (see its own docblock for why that matters for intra-batch
 * duplicates).
 */
export function validateOneRow(row: ParsedRow, ctx: RowValidationContext): ValidatedRow {
  const errors: RowValidationError[] = [];

  if (!row.projectName) {
    errors.push({ field: "project_name", reason: "Project name is required." });
  }
  if (!row.vendorName) {
    errors.push({ field: "vendor_name", reason: "Vendor name is required." });
  }
  if (row.contactEmail && !EMAIL_SHAPE.test(row.contactEmail)) {
    errors.push({
      field: "contact_email",
      reason: `"${row.contactEmail}" does not look like a valid email address.`,
    });
  }
  if (row.trade && !(TRADE_VALUES as readonly string[]).includes(row.trade)) {
    errors.push({
      field: "trade",
      reason: `"${row.trade}" is not a recognized trade. Expected one of: ${TRADE_VALUES.join(", ")}.`,
    });
  }
  if (row.riskTier && !(RISK_TIER_VALUES as readonly string[]).includes(row.riskTier)) {
    errors.push({
      field: "risk_tier",
      reason: `"${row.riskTier}" is not a recognized risk tier. Expected one of: ${RISK_TIER_VALUES.join(", ")}.`,
    });
  }
  if (row.contractValue !== null && (Number.isNaN(row.contractValue) || row.contractValue < 0)) {
    errors.push({
      field: "contract_value",
      reason: "Contract value must be a non-negative number.",
    });
  }

  const willCreateProject = row.projectName
    ? !ctx.existingProjectNames.has(normalizeProjectMatch(row.projectName))
    : false;

  const normalizedEmail = row.contactEmail ? normalizeMatch(row.contactEmail) : "";
  const willCreateVendor = row.vendorName
    ? !(
        ctx.existingVendorNames.has(normalizeMatch(row.vendorName)) ||
        (normalizedEmail !== "" && ctx.existingVendorEmails.has(normalizedEmail))
      )
    : false;

  return {
    rowNumber: row.rowNumber,
    status: errors.length === 0 ? "valid" : "rejected",
    errors,
    willCreateProject,
    willCreateVendor,
  };
}

/**
 * Validates every row in order, folding each VALID row's own project/vendor
 * name+email into a working copy of ctx before validating the next row - two
 * rows in the same CSV that name the same new project/vendor must predict
 * "create once, reuse after" exactly like the DB-backed execute phase will
 * (import_vendor_row() sees the first row's real insert committed before the
 * second row's lookup runs, since each row is its own sequential RPC call).
 * A rejected row's own project/vendor is NOT folded in - executeVendorImport()
 * never calls import_vendor_row() for a rejected row, so nothing about it
 * actually gets created.
 */
export function validateRows(rows: ParsedRow[], seed: RowValidationContext): ValidatedRow[] {
  const ctx: RowValidationContext = {
    existingProjectNames: new Set(seed.existingProjectNames),
    existingVendorNames: new Set(seed.existingVendorNames),
    existingVendorEmails: new Set(seed.existingVendorEmails),
  };

  return rows.map((row) => {
    const result = validateOneRow(row, ctx);
    if (result.status === "valid") {
      if (row.projectName) ctx.existingProjectNames.add(normalizeProjectMatch(row.projectName));
      if (row.vendorName) ctx.existingVendorNames.add(normalizeMatch(row.vendorName));
      if (row.contactEmail) {
        const normalized = normalizeMatch(row.contactEmail);
        if (normalized) ctx.existingVendorEmails.add(normalized);
      }
    }
    return result;
  });
}

/** Reads existing projects/vendors for this company on the request-scoped client - RLS-protected, exactly the read an ordinary signed-in company member may already do for their own company (no elevated privilege needed for preview/validate; only execute()'s writes need import_vendor_row()'s SECURITY DEFINER escalation). */
async function fetchValidationContext(
  supabase: SupabaseClient,
  companyId: string,
): Promise<RowValidationContext> {
  const [{ data: projects, error: projectsError }, { data: vendors, error: vendorsError }] =
    await Promise.all([
      supabase.from("projects").select("name").eq("company_id", companyId),
      supabase.from("vendors").select("name, contact_email").eq("company_id", companyId),
    ]);

  if (projectsError) throw new Error(projectsError.message);
  if (vendorsError) throw new Error(vendorsError.message);

  const vendorRows = (vendors ?? []) as Array<{ name: string; contact_email: string }>;

  return {
    existingProjectNames: new Set(
      ((projects ?? []) as Array<{ name: string }>).map((p) => normalizeProjectMatch(p.name)),
    ),
    existingVendorNames: new Set(vendorRows.map((v) => normalizeMatch(v.name))),
    existingVendorEmails: new Set(
      vendorRows.map((v) => normalizeMatch(v.contact_email)).filter((email) => email !== ""),
    ),
  };
}

const parsedRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  projectName: z.string(),
  certificateHolderName: z.string(),
  certificateHolderAddress: z.string(),
  vendorName: z.string(),
  trade: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  riskTier: z.string(),
  contractValue: z.number().nullable(),
  dispatchRequest: z.boolean(),
});

const validateVendorImportRowsSchema = z.object({
  companyId: z.string().uuid(),
  rows: z.array(parsedRowSchema).min(1),
});

export interface ValidationResult {
  results: ValidatedRow[];
}

/**
 * The actual logic, taking the SupabaseClient explicitly rather than
 * resolving it itself - same split as uploadDocumentForTokenHandler()
 * (communications.ts): createServerFn's dispatch needs a "Start context"
 * that a plain test environment does not establish, so the testable core
 * lives in a bare function and the createServerFn wrapper below is a thin
 * pass-through.
 */
export async function validateVendorImportRowsHandler(
  supabase: SupabaseClient,
  companyId: string,
  rows: ParsedRow[],
): Promise<ValidationResult> {
  const ctx = await fetchValidationContext(supabase, companyId);
  return { results: validateRows(rows, ctx) };
}

export const validateVendorImportRows = createServerFn({ method: "POST" })
  .validator(validateVendorImportRowsSchema)
  .handler(async ({ data }): Promise<ValidationResult> => {
    const supabase = await getRequestScopedClient();
    return validateVendorImportRowsHandler(supabase, data.companyId, data.rows);
  });

// ---------------------------------------------------------------------------
// executeVendorImport() - the only phase that writes.
// ---------------------------------------------------------------------------

export interface RowDispatchResult {
  status: "sent" | "failed" | "not_configured" | "skipped_suppressed" | "error";
  error?: string;
}

export interface RowResult {
  rowNumber: number;
  status: "accepted" | "rejected";
  errors?: RowValidationError[];
  projectId?: string;
  projectCreated?: boolean;
  vendorId?: string;
  vendorCreated?: boolean;
  assignmentId?: string;
  assignmentCreated?: boolean;
  /** Present only when dispatchRequests was requested for this row - absent (not just "skipped") for a row that never asked for one, so the two cases are distinguishable in the summary. */
  dispatch?: RowDispatchResult;
}

export interface ExecuteResult {
  batchId: string;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  rowResults: RowResult[];
  /** true when this call short-circuited to an already-executed batch rather than processing anything - the idempotency guarantee made visible to the caller. */
  idempotentReplay: boolean;
}

const executeVendorImportSchema = z.object({
  companyId: z.string().uuid(),
  idempotencyKey: z.string().min(1),
  rows: z.array(parsedRowSchema).min(1),
  /** Company-wide toggle; a row still needs its own dispatchRequest=true to actually be dispatched - see RowResult.dispatch's own comment for why both matter. */
  dispatchRequests: z.boolean().default(false),
});

type ImportVendorRowRpcResult = {
  project_id: string;
  project_created: boolean;
  vendor_id: string;
  vendor_created: boolean;
  assignment_id: string;
  assignment_created: boolean;
};

export type DispatchUploadRequestFn = (vendorId: string) => Promise<RowDispatchResult>;

/**
 * Never throws - a request-dispatch failure for one row must not be treated
 * as that row's import having failed (the project/vendor/assignment writes
 * already committed via import_vendor_row()'s own call). Same
 * "a downstream notification failure doesn't undo an already-committed core
 * write" pattern as notifyDocumentOutcome() (communications.ts, Task 8b/9a).
 *
 * Calls createUploadRequest() the same way any other same-process caller in
 * this codebase invokes a createServerFn export - createServerFn's returned
 * function is directly callable server-side with the same `fn({ data })`
 * shape client code uses (see RequestDocumentsAction.tsx's own call); there
 * is no separate "internal" entry point to createUploadRequest() to prefer
 * over its public one.
 */
const defaultDispatchUploadRequestSafely: DispatchUploadRequestFn = async (vendorId) => {
  try {
    const result = await createUploadRequest({ data: { vendorId, purpose: "initial" } });
    return { status: result.email.status };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Could not send the upload request.",
    };
  }
};

export interface ExecuteVendorImportParams {
  companyId: string;
  idempotencyKey: string;
  rows: ParsedRow[];
  dispatchRequests: boolean;
}

/**
 * The actual logic, taking the SupabaseClient (and, for tests, the dispatch
 * function) explicitly rather than resolving them itself - same split as
 * uploadDocumentForTokenHandler() (communications.ts) and
 * validateVendorImportRowsHandler() above: createServerFn's dispatch needs a
 * "Start context" a plain test environment does not establish, so the
 * testable core lives in a bare function and the createServerFn wrapper
 * below is a thin pass-through. dispatchFn defaults to the real
 * createUploadRequest()-backed implementation; tests substitute a fake to
 * exercise the "one row's dispatch failure doesn't affect its own recorded
 * success, nor any other row" property without a real email provider.
 */
export async function executeVendorImportHandler(
  supabase: SupabaseClient,
  params: ExecuteVendorImportParams,
  dispatchFn: DispatchUploadRequestFn = defaultDispatchUploadRequestSafely,
): Promise<ExecuteResult> {
  const data = params;

  // Idempotency check FIRST, before anything else runs - a retried
  // submission (e.g. after a network timeout where the caller isn't sure
  // whether the first attempt landed) must return the exact same answer
  // both times, never process a second import. vendor_import_batches'
  // `unique (company_id, idempotency_key)` is what this relies on.
  const { data: existingBatch, error: existingBatchError } = await supabase
    .from("vendor_import_batches")
    .select("id, total_rows, accepted_rows, rejected_rows, row_results")
    .eq("company_id", data.companyId)
    .eq("idempotency_key", data.idempotencyKey)
    .maybeSingle();

  if (existingBatchError) throw new Error(existingBatchError.message);

  if (existingBatch) {
    return {
      batchId: existingBatch.id,
      totalRows: existingBatch.total_rows,
      acceptedRows: existingBatch.accepted_rows,
      rejectedRows: existingBatch.rejected_rows,
      rowResults: existingBatch.row_results as RowResult[],
      idempotentReplay: true,
    };
  }

  // Re-validate defensively rather than trusting the caller already called
  // validateVendorImportRows() and is now just confirming - a stale or
  // tampered client-side "confirm" step must not be able to skip
  // validation, matching this project's general defense-in-depth posture
  // (see e.g. sendRequest()'s own re-verification of confirmed recipient
  // ids against vendor_contacts rather than trusting the caller's claim).
  const ctx = await fetchValidationContext(supabase, data.companyId);
  const validated = validateRows(data.rows, ctx);
  const validatedByRow = new Map(validated.map((v) => [v.rowNumber, v]));

  const rowResults: RowResult[] = [];
  let acceptedRows = 0;
  let rejectedRows = 0;

  for (const row of data.rows) {
    const validation = validatedByRow.get(row.rowNumber);

    // A rejected row - or one this re-validation pass could not find at
    // all - is never passed to import_vendor_row(): "rejected rows do not
    // partially write" holds because nothing is ever attempted for them.
    if (!validation || validation.status === "rejected") {
      rejectedRows += 1;
      rowResults.push({
        rowNumber: row.rowNumber,
        status: "rejected",
        errors: validation?.errors ?? [
          { field: "row", reason: "This row could not be matched to a validated row." },
        ],
      });
      continue;
    }

    // One transaction per accepted row: import_vendor_row() is a single
    // RPC call, which is implicitly one Postgres transaction - it either
    // fully commits this row's project/vendor/assignment writes or fully
    // rolls back, independent of every other row in this loop.
    const { data: rpcResult, error: rpcError } = await supabase.rpc("import_vendor_row", {
      p_company_id: data.companyId,
      p_project_name: row.projectName,
      p_certificate_holder_name: row.certificateHolderName,
      p_certificate_holder_address: row.certificateHolderAddress,
      p_vendor_name: row.vendorName,
      p_trade: row.trade || null,
      p_contact_name: row.contactName,
      p_contact_email: row.contactEmail,
      p_risk_tier: row.riskTier || null,
      p_contract_value: row.contractValue,
    });

    if (rpcError || !rpcResult) {
      rejectedRows += 1;
      rowResults.push({
        rowNumber: row.rowNumber,
        status: "rejected",
        errors: [{ field: "row", reason: rpcError?.message ?? "Could not write this row." }],
      });
      continue;
    }

    const resolved = rpcResult as ImportVendorRowRpcResult;

    let dispatch: RowDispatchResult | undefined;
    if (data.dispatchRequests && row.dispatchRequest) {
      dispatch = await dispatchFn(resolved.vendor_id);
    }

    acceptedRows += 1;
    rowResults.push({
      rowNumber: row.rowNumber,
      status: "accepted",
      projectId: resolved.project_id,
      projectCreated: resolved.project_created,
      vendorId: resolved.vendor_id,
      vendorCreated: resolved.vendor_created,
      assignmentId: resolved.assignment_id,
      assignmentCreated: resolved.assignment_created,
      // Spread rather than a plain `dispatch` key: with
      // exactOptionalPropertyTypes, assigning `dispatch: undefined` is a
      // type error against an optional (not `| undefined`) property - and
      // RowResult.dispatch's own docblock requires the key be ABSENT (not
      // present-but-undefined) for a row that never asked for one.
      ...(dispatch ? { dispatch } : {}),
    });
  }

  // ONE batch row summarizing the whole run - what makes the NEXT call
  // with this same idempotency key short-circuit correctly above.
  // uploaded_by is left unset: vendor_import_batches_set_uploader (the
  // BEFORE INSERT trigger, 20260917001500_vendor_import.sql) fills it from
  // auth.uid(), the same "omit it and it just works" ergonomics as
  // audit_log.actor_id.
  const { data: batch, error: insertError } = await supabase
    .from("vendor_import_batches")
    .insert({
      company_id: data.companyId,
      idempotency_key: data.idempotencyKey,
      total_rows: data.rows.length,
      accepted_rows: acceptedRows,
      rejected_rows: rejectedRows,
      row_results: rowResults,
    })
    .select("id")
    .single();

  // A unique-violation here means a concurrent call already won the race
  // for this exact (company_id, idempotency_key) between this call's own
  // existingBatch check above and this insert - re-fetch and return ITS
  // result rather than throwing, so two near-simultaneous retries of the
  // same submission still converge on one answer instead of one of them
  // failing outright.
  if (insertError?.code === "23505") {
    const { data: raceBatch, error: raceError } = await supabase
      .from("vendor_import_batches")
      .select("id, total_rows, accepted_rows, rejected_rows, row_results")
      .eq("company_id", data.companyId)
      .eq("idempotency_key", data.idempotencyKey)
      .single();

    if (raceError || !raceBatch) throw new Error(insertError.message);

    return {
      batchId: raceBatch.id,
      totalRows: raceBatch.total_rows,
      acceptedRows: raceBatch.accepted_rows,
      rejectedRows: raceBatch.rejected_rows,
      rowResults: raceBatch.row_results as RowResult[],
      idempotentReplay: true,
    };
  }

  if (insertError || !batch) {
    throw new Error(insertError?.message ?? "Could not record this import.");
  }

  await supabase.from("audit_log").insert({
    company_id: data.companyId,
    action: "vendor_import_executed",
    target_type: "vendor_import_batch",
    target_id: batch.id,
    detail: { totalRows: data.rows.length, acceptedRows, rejectedRows },
  });

  return {
    batchId: batch.id,
    totalRows: data.rows.length,
    acceptedRows,
    rejectedRows,
    rowResults,
    idempotentReplay: false,
  };
}

export const executeVendorImport = createServerFn({ method: "POST" })
  .validator(executeVendorImportSchema)
  .handler(async ({ data }): Promise<ExecuteResult> => {
    const supabase = await getRequestScopedClient();
    return executeVendorImportHandler(supabase, data);
  });
