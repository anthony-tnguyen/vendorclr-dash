import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { DocumentKind } from "@/data/dbTypeAliases";
import {
  currentClientIp,
  enqueueExtractionJob,
  rejectInvalidToken,
  resolveActiveUploadRequestByToken,
  type ResolvedTokenRow,
} from "./vendorUploadRequests";
import { buildStoragePath, hashFileBytes, hashToken, MAX_UPLOAD_BYTES } from "./uploadTokens";

/**
 * Task 8a - the package-based vendor upload workflow: createPackage(),
 * addPackageDocument(), finalizePackage(), replaceDeficientDocument().
 *
 * A deliberate PARALLEL path to uploadDocumentForToken() (vendorUploadRequests.ts),
 * not a replacement of it - see that file's own updated docblock. Every
 * function here is called by the anonymous vendor from the same magic-link
 * token uploadDocumentForToken() already uses; there is still no Supabase
 * session to run any of this as, so every handler re-validates the token by
 * hand (via resolveActiveUploadRequestByToken()/rejectInvalidToken(), both
 * exported from vendorUploadRequests.ts so the token-resolution and abuse-
 * bucket behavior is identical, not a second slightly-different
 * implementation) and then drops to the service-role client, exactly like
 * uploadDocumentForToken() does.
 *
 * Lazily imported below, same as vendorUploadRequests.ts: a static import of
 * a *.server module here would put it in the client bundle's import graph,
 * which this project's Vite config rejects (src/server/** and any *.server
 * module it pulls in) - see that file's own docblock for the fuller
 * reasoning, not repeated per file.
 */
async function getServiceRoleClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getServiceRoleClient();
}
async function getUploadAbuseModule() {
  return import("./uploadAbuse.server");
}
async function getFileValidationModule() {
  return import("./fileValidation.server");
}
import { getMalwareScanner } from "./malwareScanner";

const DOCUMENT_KIND_VALUES = [
  "certificate_of_insurance",
  "additional_insured_endorsement",
  "waiver_of_subrogation_endorsement",
  "primary_noncontributory_endorsement",
  "other",
] as const satisfies readonly DocumentKind[];

const DocumentKindSchema = z.enum(DOCUMENT_KIND_VALUES);

/**
 * Written once, the first time a package is opened for an upload request
 * (see openOrGetCurrentPackage() below) - company-configurable checklists
 * are a later task's concern (per the top-level plan), so for now every
 * upload request gets the same starter checklist: a Certificate of
 * Insurance is always required; the two endorsements commonly requested
 * alongside it are listed but not required, since not every vendor/project
 * needs them. 'other' and 'primary_noncontributory_endorsement' are not
 * pre-seeded as checklist lines - a vendor can still attach a document under
 * either kind via addPackageDocument(), it just never blocks
 * finalizePackage().
 */
const DEFAULT_CHECKLIST: ReadonlyArray<{ documentKind: DocumentKind; isRequired: boolean }> = [
  { documentKind: "certificate_of_insurance", isRequired: true },
  { documentKind: "additional_insured_endorsement", isRequired: false },
  { documentKind: "waiver_of_subrogation_endorsement", isRequired: false },
];

export interface PackageChecklistItemView {
  documentKind: DocumentKind;
  isRequired: boolean;
  satisfied: boolean;
}

interface PackageRow {
  id: string;
  version: number;
  status: string;
  upload_request_id: string;
}

/** The checklist for an upload request, joined against what a specific package version has actually collected - same shape as submissionRepository.ts's getChecklistCompletion(), duplicated here rather than imported because that file uses the request-scoped client (an authenticated staff session) and everything in this module runs on the service-role client after a token check - the two are not interchangeable. */
async function fetchChecklistView(
  supabase: SupabaseClient,
  uploadRequestId: string,
  packageId: string,
): Promise<PackageChecklistItemView[]> {
  const [{ data: checklist }, { data: documents }] = await Promise.all([
    supabase
      .from("upload_request_checklist_items")
      .select("document_kind, is_required")
      .eq("upload_request_id", uploadRequestId),
    supabase.from("package_documents").select("document_kind").eq("package_id", packageId),
  ]);

  const satisfiedKinds = new Set(
    ((documents ?? []) as Array<{ document_kind: string }>).map((d) => d.document_kind),
  );

  return ((checklist ?? []) as Array<{ document_kind: string; is_required: boolean }>).map(
    (item) => ({
      documentKind: item.document_kind as DocumentKind,
      isRequired: item.is_required,
      satisfied: satisfiedKinds.has(item.document_kind),
    }),
  );
}

/**
 * The upload request's currently-open package, or its single most recent
 * package if none is open - createPackage() is idempotent: calling it again
 * after the first file has already been added (or even after finalization)
 * just returns the existing state rather than erroring or creating a
 * second, conflicting package (submission_packages_one_open_per_request, the
 * partial unique index from the schema migration, would reject a second
 * open row for the same upload request outright - this check exists so a
 * vendor reloading the portal page gets back their in-progress package
 * instead of a raw database constraint error).
 */
async function openOrGetCurrentPackage(
  supabase: SupabaseClient,
  request: ResolvedTokenRow,
): Promise<PackageRow> {
  const { data: existing } = await supabase
    .from("submission_packages")
    .select("id, version, status, upload_request_id")
    .eq("upload_request_id", request.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return existing as PackageRow;

  const { data: created, error } = await supabase
    .from("submission_packages")
    .insert({
      company_id: request.companyId,
      vendor_id: request.vendorId,
      upload_request_id: request.id,
      version: 1,
    })
    .select("id, version, status, upload_request_id")
    .single();

  if (error || !created) throw new Error("Could not open a submission package.");

  const { data: existingChecklist } = await supabase
    .from("upload_request_checklist_items")
    .select("id")
    .eq("upload_request_id", request.id)
    .limit(1);

  if (!existingChecklist || existingChecklist.length === 0) {
    await supabase.from("upload_request_checklist_items").insert(
      DEFAULT_CHECKLIST.map((item) => ({
        company_id: request.companyId,
        vendor_id: request.vendorId,
        upload_request_id: request.id,
        document_kind: item.documentKind,
        is_required: item.isRequired,
      })),
    );
  }

  return created as PackageRow;
}

// ---------------------------------------------------------------------------
// createPackage
// ---------------------------------------------------------------------------

const tokenOnlySchema = z.object({ token: z.string().min(1) });

export interface CreatePackageResult {
  packageId: string;
  version: number;
  status: string;
  checklist: PackageChecklistItemView[];
}

export async function createPackageHandler(
  token: string,
  ipAddress: string,
): Promise<CreatePackageResult> {
  const request = await resolveActiveUploadRequestByToken(token, ipAddress);
  const supabase = await getServiceRoleClient();
  const pkg = await openOrGetCurrentPackage(supabase, request);
  const checklist = await fetchChecklistView(supabase, request.id, pkg.id);
  return { packageId: pkg.id, version: pkg.version, status: pkg.status, checklist };
}

export const createPackage = createServerFn({ method: "POST" })
  .validator(tokenOnlySchema)
  .handler(async ({ data }): Promise<CreatePackageResult> => {
    const ipAddress = await currentClientIp();
    return createPackageHandler(data.token, ipAddress);
  });

// ---------------------------------------------------------------------------
// addPackageDocument - stores + scans a file synchronously, but never
// extracts inline (see finalizePackage() below for where extraction is
// actually enqueued).
// ---------------------------------------------------------------------------

export interface AddPackageDocumentResult {
  documentId: string;
  packageId: string;
  documentKind: DocumentKind;
  checklist: PackageChecklistItemView[];
}

export async function addPackageDocumentHandler(
  formData: FormData,
  ipAddress: string,
): Promise<AddPackageDocumentResult> {
  const token = formData.get("token");
  const packageId = formData.get("packageId");
  const rawDocumentKind = formData.get("documentKind");
  const file = formData.get("file");

  if (typeof token !== "string" || !token) await rejectInvalidToken(ipAddress);
  if (typeof packageId !== "string" || !packageId) await rejectInvalidToken(ipAddress);

  const documentKindResult = DocumentKindSchema.safeParse(rawDocumentKind);
  if (!documentKindResult.success) {
    throw new Error("Unrecognized document type.");
  }
  const documentKind = documentKindResult.data;

  const request = await resolveActiveUploadRequestByToken(token as string, ipAddress);
  const supabase = await getServiceRoleClient();

  const { data: pkg } = await supabase
    .from("submission_packages")
    .select("id, version, status, upload_request_id")
    .eq("id", packageId as string)
    .maybeSingle();

  // Same "one identical message" principle as rejectInvalidToken(): a
  // package that does not exist, belongs to a different upload request, or
  // is no longer open all look the same to the caller.
  if (!pkg || pkg.upload_request_id !== request.id || pkg.status !== "open") {
    throw new Error("This submission can no longer accept files.");
  }

  // Same abuse-bucket call uploadDocumentForTokenHandler() makes, in the
  // same order (before the file itself is inspected) and for the same
  // reason - see that function's own comment at this call site.
  const { assertUploadAllowed } = await getUploadAbuseModule();
  await assertUploadAllowed({
    operation: "upload",
    ipAddress,
    tokenHash: await hashToken(token as string),
    companyId: request.companyId,
  });

  if (!(file instanceof File)) throw new Error("No file was attached.");
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File must be under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`);
  }

  const { validateUploadedFile, FileValidationError } = await getFileValidationModule();
  let validated: Awaited<ReturnType<typeof validateUploadedFile>>;
  try {
    validated = await validateUploadedFile(file);
  } catch (error) {
    throw error instanceof FileValidationError
      ? new Error(error.message)
      : new Error("Could not read the uploaded file. Try again.");
  }

  if (validated.encryptedPdf) {
    throw new Error("This PDF is password-protected. Remove the password and re-upload it.");
  }

  const { bytes, detectedMime } = validated;
  const sha256 = await hashFileBytes(bytes);

  const scanResult = await getMalwareScanner().scan(sha256);
  if (scanResult.status === "malicious") {
    throw new Error(
      "This file was flagged by a malware scan and could not be uploaded. Contact support if you believe this is an error.",
    );
  }

  const documentId = crypto.randomUUID();
  const storagePath = buildStoragePath({
    companyId: request.companyId,
    vendorId: request.vendorId,
    documentId,
    mimeType: detectedMime,
  });

  const { error: uploadError } = await supabase.storage
    .from("vendor-documents")
    .upload(storagePath, bytes, { contentType: detectedMime, upsert: false });

  if (uploadError) throw new Error("Could not store the file. Try again.");

  const { error: docError } = await supabase.from("vendor_documents").insert({
    id: documentId,
    company_id: request.companyId,
    vendor_id: request.vendorId,
    upload_request_id: request.id,
    storage_path: storagePath,
    file_name: file.name || `document.${detectedMime.split("/")[1] ?? "pdf"}`,
    mime_type: detectedMime,
    file_size: file.size,
    sha256,
    source: "vendor_portal",
    malware_scan_status: scanResult.status,
    malware_scan_detail: scanResult.detail,
    scanned_at: new Date().toISOString(),
  });

  if (docError) throw new Error("Could not record the upload. Try again.");

  // A vendor correcting a mis-upload before finalizing (wrong file under the
  // same checklist slot) replaces the LINK, not the stored document - the
  // earlier upload stays on vendor_documents as-is (nothing is ever
  // deleted), it is simply no longer attached to this package version. Only
  // matters pre-finalize: after finalizePackage(), the package is immutable
  // and correction goes through replaceDeficientDocument() instead, which
  // creates a new package VERSION rather than mutating this one.
  await supabase
    .from("package_documents")
    .delete()
    .eq("package_id", pkg.id)
    .eq("document_kind", documentKind);

  const { error: linkError } = await supabase.from("package_documents").insert({
    company_id: request.companyId,
    vendor_id: request.vendorId,
    package_id: pkg.id,
    document_id: documentId,
    document_kind: documentKind,
  });

  if (linkError) throw new Error("Could not attach the file to this submission. Try again.");

  const checklist = await fetchChecklistView(supabase, request.id, pkg.id);
  return { documentId, packageId: pkg.id, documentKind, checklist };
}

export const addPackageDocument = createServerFn({ method: "POST" })
  .validator((formData: FormData) => formData)
  .handler(async ({ data: formData }): Promise<AddPackageDocumentResult> => {
    const ipAddress = await currentClientIp();
    return addPackageDocumentHandler(formData, ipAddress);
  });

// ---------------------------------------------------------------------------
// finalizePackage
// ---------------------------------------------------------------------------

const finalizePackageSchema = z.object({ token: z.string().min(1), packageId: z.string().uuid() });

export interface FinalizePackageResult {
  packageId: string;
  status: "finalized";
  /** Already finalized when this call arrived - a repeat click/retry, not a fresh finalize. No new jobs were enqueued. */
  alreadyFinalized: boolean;
}

/**
 * Validates every required checklist item has a matching uploaded document,
 * marks the package finalized, and enqueues one document_processing_jobs row
 * per document in the package - the mechanism that removes extraction from
 * the browser's critical path (see vendorUploadRequests.ts's updated
 * docblock and the document_processing_jobs migration for the fuller
 * picture).
 *
 * Idempotent at the package level, by design choice: finalizing an already-
 * finalized package is a silent no-op that returns the current state
 * (alreadyFinalized: true) rather than throwing. A vendor's browser retrying
 * a slow/dropped response, or double-clicking submit, must not re-run
 * validation or enqueue a second round of jobs - enqueueExtractionJob()'s
 * own idempotency_key uniqueness would prevent duplicate ROWS even if this
 * function re-tried the enqueue loop, but skipping the whole re-finalize
 * here is simpler and avoids re-validating a checklist that cannot have
 * changed (package_documents on a finalized package is immutable - see
 * addPackageDocument()'s docblock).
 */
export async function finalizePackageHandler(
  token: string,
  packageId: string,
  ipAddress: string,
): Promise<FinalizePackageResult> {
  const request = await resolveActiveUploadRequestByToken(token, ipAddress);
  const supabase = await getServiceRoleClient();

  const { data: pkg } = await supabase
    .from("submission_packages")
    .select("id, version, status, upload_request_id")
    .eq("id", packageId)
    .maybeSingle();

  if (!pkg || pkg.upload_request_id !== request.id) {
    throw new Error("Submission not found.");
  }

  if (pkg.status === "finalized") {
    return { packageId: pkg.id, status: "finalized", alreadyFinalized: true };
  }
  if (pkg.status === "superseded") {
    throw new Error("This submission has already been replaced by a newer one.");
  }

  const checklist = await fetchChecklistView(supabase, request.id, pkg.id);
  const missing = checklist.filter((item) => item.isRequired && !item.satisfied);
  if (missing.length > 0) {
    throw new Error(
      `Please upload: ${missing.map((m) => m.documentKind.replace(/_/g, " ")).join(", ")}.`,
    );
  }

  const { data: documents } = await supabase
    .from("package_documents")
    .select("document_id")
    .eq("package_id", pkg.id);

  const { error: updateError } = await supabase
    .from("submission_packages")
    .update({ status: "finalized", finalized_at: new Date().toISOString() })
    .eq("id", pkg.id)
    .eq("status", "open"); // Extra guard against a racing double-finalize; see docblock.

  if (updateError) throw new Error("Could not finalize this submission. Try again.");

  for (const doc of (documents ?? []) as Array<{ document_id: string }>) {
    await enqueueExtractionJob(supabase, {
      companyId: request.companyId,
      vendorId: request.vendorId,
      documentId: doc.document_id,
      packageId: pkg.id,
    });
  }

  await supabase
    .from("vendor_upload_requests")
    .update({ status: "uploaded", uploaded_at: new Date().toISOString() })
    .eq("id", request.id);

  await supabase.from("audit_log").insert({
    company_id: request.companyId,
    action: "submission_package_finalized",
    target_type: "submission_package",
    target_id: pkg.id,
    detail: {
      vendorId: request.vendorId,
      version: pkg.version,
      documentCount: documents?.length ?? 0,
    },
  });

  return { packageId: pkg.id, status: "finalized", alreadyFinalized: false };
}

export const finalizePackage = createServerFn({ method: "POST" })
  .validator(finalizePackageSchema)
  .handler(async ({ data }): Promise<FinalizePackageResult> => {
    const ipAddress = await currentClientIp();
    return finalizePackageHandler(data.token, data.packageId, ipAddress);
  });

// ---------------------------------------------------------------------------
// replaceDeficientDocument
// ---------------------------------------------------------------------------

export interface ReplaceDeficientDocumentResult {
  packageId: string;
  version: number;
  replacedDocumentId: string;
  newDocumentId: string;
}

/**
 * Swaps one specific document in an already-finalized package for a
 * corrected upload, without requiring the vendor to re-upload anything
 * else - the "resubmission" path the top-level task's Definition of Done
 * calls out by name.
 *
 * Creates a NEW submission_packages row (version = latest + 1,
 * previous_package_id = latest.id, immediately 'finalized' - see this
 * function's body for why auto-finalizing is the right call here rather
 * than reopening a version for further edits), marks the latest version
 * 'superseded', and copies every OTHER package_documents link from the old
 * version into the new one unchanged - only the replaced slot points at the
 * newly uploaded document. Enqueues a processing job scoped to ONLY the new
 * document, not the whole package: every carried-over document already has
 * a (or will get its own) extraction result: this project's Task 8b
 * dispatch note documents the alternative (re-enqueue the whole package) as
 * the "genuinely simpler" fallback if the worker ends up needing
 * package-level context it can't otherwise get - see that migration's
 * handoff comment.
 */
export async function replaceDeficientDocumentHandler(
  formData: FormData,
  ipAddress: string,
): Promise<ReplaceDeficientDocumentResult> {
  const token = formData.get("token");
  const replacesDocumentId = formData.get("replacesDocumentId");
  const file = formData.get("file");

  if (typeof token !== "string" || !token) await rejectInvalidToken(ipAddress);
  if (typeof replacesDocumentId !== "string" || !replacesDocumentId) {
    await rejectInvalidToken(ipAddress);
  }

  const request = await resolveActiveUploadRequestByToken(token as string, ipAddress);
  const supabase = await getServiceRoleClient();

  const { data: latest } = await supabase
    .from("submission_packages")
    .select("id, version, status, upload_request_id")
    .eq("upload_request_id", request.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest || latest.status !== "finalized") {
    throw new Error("There is no finalized submission to correct.");
  }

  const { data: oldLink } = await supabase
    .from("package_documents")
    .select("document_id, document_kind")
    .eq("package_id", latest.id)
    .eq("document_id", replacesDocumentId as string)
    .maybeSingle();

  if (!oldLink) {
    throw new Error("That document is not part of your most recent submission.");
  }

  const { assertUploadAllowed } = await getUploadAbuseModule();
  await assertUploadAllowed({
    operation: "upload",
    ipAddress,
    tokenHash: await hashToken(token as string),
    companyId: request.companyId,
  });

  if (!(file instanceof File)) throw new Error("No file was attached.");
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File must be under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`);
  }

  const { validateUploadedFile, FileValidationError } = await getFileValidationModule();
  let validated: Awaited<ReturnType<typeof validateUploadedFile>>;
  try {
    validated = await validateUploadedFile(file);
  } catch (error) {
    throw error instanceof FileValidationError
      ? new Error(error.message)
      : new Error("Could not read the uploaded file. Try again.");
  }

  if (validated.encryptedPdf) {
    throw new Error("This PDF is password-protected. Remove the password and re-upload it.");
  }

  const { bytes, detectedMime } = validated;
  const sha256 = await hashFileBytes(bytes);

  const scanResult = await getMalwareScanner().scan(sha256);
  if (scanResult.status === "malicious") {
    throw new Error(
      "This file was flagged by a malware scan and could not be uploaded. Contact support if you believe this is an error.",
    );
  }

  const newDocumentId = crypto.randomUUID();
  const storagePath = buildStoragePath({
    companyId: request.companyId,
    vendorId: request.vendorId,
    documentId: newDocumentId,
    mimeType: detectedMime,
  });

  const { error: uploadError } = await supabase.storage
    .from("vendor-documents")
    .upload(storagePath, bytes, { contentType: detectedMime, upsert: false });

  if (uploadError) throw new Error("Could not store the file. Try again.");

  const { error: docError } = await supabase.from("vendor_documents").insert({
    id: newDocumentId,
    company_id: request.companyId,
    vendor_id: request.vendorId,
    upload_request_id: request.id,
    storage_path: storagePath,
    file_name: file.name || `document.${detectedMime.split("/")[1] ?? "pdf"}`,
    mime_type: detectedMime,
    file_size: file.size,
    sha256,
    source: "vendor_portal",
    replaces_document_id: oldLink.document_id,
    malware_scan_status: scanResult.status,
    malware_scan_detail: scanResult.detail,
    scanned_at: new Date().toISOString(),
  });

  if (docError) throw new Error("Could not record the upload. Try again.");

  const { data: newPackage, error: packageError } = await supabase
    .from("submission_packages")
    .insert({
      company_id: request.companyId,
      vendor_id: request.vendorId,
      upload_request_id: request.id,
      version: latest.version + 1,
      previous_package_id: latest.id,
      status: "finalized",
      finalized_at: new Date().toISOString(),
    })
    .select("id, version")
    .single();

  if (packageError || !newPackage) throw new Error("Could not create the corrected submission.");

  const { data: carriedLinks } = await supabase
    .from("package_documents")
    .select("document_id, document_kind")
    .eq("package_id", latest.id);

  const linksForNewVersion = (
    (carriedLinks ?? []) as Array<{
      document_id: string;
      document_kind: string;
    }>
  ).map((link) =>
    link.document_id === oldLink.document_id
      ? { document_id: newDocumentId, document_kind: oldLink.document_kind }
      : link,
  );

  const { error: linkError } = await supabase.from("package_documents").insert(
    linksForNewVersion.map((link) => ({
      company_id: request.companyId,
      vendor_id: request.vendorId,
      package_id: newPackage.id,
      document_id: link.document_id,
      document_kind: link.document_kind,
    })),
  );

  if (linkError) throw new Error("Could not assemble the corrected submission. Try again.");

  await supabase.from("submission_packages").update({ status: "superseded" }).eq("id", latest.id);

  // Scoped to just the replaced document - see this function's own docblock.
  await enqueueExtractionJob(supabase, {
    companyId: request.companyId,
    vendorId: request.vendorId,
    documentId: newDocumentId,
    packageId: newPackage.id,
  });

  await supabase
    .from("vendor_upload_requests")
    .update({ status: "uploaded", uploaded_at: new Date().toISOString() })
    .eq("id", request.id);

  await supabase.from("audit_log").insert({
    company_id: request.companyId,
    action: "submission_document_replaced",
    target_type: "vendor_document",
    target_id: newDocumentId,
    detail: {
      vendorId: request.vendorId,
      replacedDocumentId: oldLink.document_id,
      newPackageId: newPackage.id,
      newPackageVersion: newPackage.version,
    },
  });

  return {
    packageId: newPackage.id,
    version: newPackage.version,
    replacedDocumentId: oldLink.document_id,
    newDocumentId,
  };
}

export const replaceDeficientDocument = createServerFn({ method: "POST" })
  .validator((formData: FormData) => formData)
  .handler(async ({ data: formData }): Promise<ReplaceDeficientDocumentResult> => {
    const ipAddress = await currentClientIp();
    return replaceDeficientDocumentHandler(formData, ipAddress);
  });
