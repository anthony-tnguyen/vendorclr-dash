import type {
  DocumentProcessingJobRow,
  PackageDocumentRow,
  SubmissionPackageRow,
  UploadRequestChecklistItemRow,
} from "@/data/dbTypeAliases";

/**
 * Read-mostly repository over submission_packages / package_documents /
 * upload_request_checklist_items / document_processing_jobs (Task 8a -
 * supabase/migrations/20260917000300_submission_packages.sql and
 * 20260917000400_document_processing_jobs.sql).
 *
 * Same shape and conventions as requirementRepository.ts/contactRepository.ts:
 * request-scoped client, thin typed wrappers, no business logic - the
 * package lifecycle (createPackage/addPackageDocument/finalizePackage/
 * replaceDeficientDocument) lives in src/workflows/submissionPackages.ts,
 * not here. This file is what a future authenticated admin/operations
 * screen reads from to show package status, checklist completeness, and
 * per-document processing state - it is NOT what the anonymous vendor
 * portal uses (that goes through the service-role client inside the
 * workflow functions themselves, exactly like vendor_documents/
 * vendor_upload_requests today).
 */
async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data and no error");
  return result.data;
}

// ---------------------------------------------------------------------------
// submission_packages
// ---------------------------------------------------------------------------

/** Every package version for one upload request, oldest first - the full lineage a future UI would render as a resubmission history. */
export async function listPackagesForUploadRequest(
  uploadRequestId: string,
): Promise<SubmissionPackageRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("submission_packages")
    .select("*")
    .eq("upload_request_id", uploadRequestId)
    .order("version", { ascending: true })) as unknown as {
    data: SubmissionPackageRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** Every package for a vendor across every upload request it has ever had, newest first. */
export async function listPackagesForVendor(vendorId: string): Promise<SubmissionPackageRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("submission_packages")
    .select("*")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })) as unknown as {
    data: SubmissionPackageRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** One package by id, or null if it does not exist / is not visible to the caller. */
export async function getPackage(packageId: string): Promise<SubmissionPackageRow | null> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("submission_packages")
    .select("*")
    .eq("id", packageId)
    .maybeSingle()) as unknown as {
    data: SubmissionPackageRow | null;
    error: { message: string } | null;
  };
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/** The currently-open (or most recent, if none is open) package for an upload request - what a future UI resumes uploading into. */
export async function getCurrentPackageForUploadRequest(
  uploadRequestId: string,
): Promise<SubmissionPackageRow | null> {
  const packages = await listPackagesForUploadRequest(uploadRequestId);
  if (packages.length === 0) return null;
  return packages.find((p) => p.status === "open") ?? packages[packages.length - 1]!;
}

// ---------------------------------------------------------------------------
// package_documents
// ---------------------------------------------------------------------------

/** Every document linked into one package version, in the order they were added. */
export async function listPackageDocuments(packageId: string): Promise<PackageDocumentRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("package_documents")
    .select("*")
    .eq("package_id", packageId)
    .order("created_at", { ascending: true })) as unknown as {
    data: PackageDocumentRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

// ---------------------------------------------------------------------------
// upload_request_checklist_items
// ---------------------------------------------------------------------------

/** Every checklist line for an upload request - shared across every version of that request's package lineage. */
export async function listChecklistItems(
  uploadRequestId: string,
): Promise<UploadRequestChecklistItemRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("upload_request_checklist_items")
    .select("*")
    .eq("upload_request_id", uploadRequestId)
    .order("document_kind", { ascending: true })) as unknown as {
    data: UploadRequestChecklistItemRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

export interface ChecklistCompletionItem {
  documentKind: UploadRequestChecklistItemRow["document_kind"];
  isRequired: boolean;
  /** True once at least one package_documents row of this kind exists in the given package. */
  satisfied: boolean;
}

/**
 * The checklist joined against what a specific package version has actually
 * collected so far - what a future portal UI renders as "exact checklist"
 * progress (per this task's own checklist item). Two reads plus an
 * in-memory join, not a PostgREST embed: package_documents has no direct FK
 * to upload_request_checklist_items (they're matched on document_kind, not
 * a foreign key - see that migration's docblock for why), so there is no
 * relationship for PostgREST to embed through.
 */
export async function getChecklistCompletion(
  uploadRequestId: string,
  packageId: string,
): Promise<ChecklistCompletionItem[]> {
  const [checklist, documents] = await Promise.all([
    listChecklistItems(uploadRequestId),
    listPackageDocuments(packageId),
  ]);
  const satisfiedKinds = new Set(documents.map((d) => d.document_kind));
  return checklist.map((item) => ({
    documentKind: item.document_kind,
    isRequired: item.is_required,
    satisfied: satisfiedKinds.has(item.document_kind),
  }));
}

// ---------------------------------------------------------------------------
// document_processing_jobs
// ---------------------------------------------------------------------------

/** Every processing job enqueued for one package - operations visibility into extraction progress, including 'exhausted' rows once Task 8b's worker starts writing them. */
export async function listProcessingJobsForPackage(
  packageId: string,
): Promise<DocumentProcessingJobRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("document_processing_jobs")
    .select("*")
    .eq("target_package_id", packageId)
    .order("created_at", { ascending: true })) as unknown as {
    data: DocumentProcessingJobRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** Every processing job for a company, most recent first - the source list an operations screen filters down to 'exhausted'/'failed' rows needing attention. */
export async function listProcessingJobsForCompany(
  companyId: string,
): Promise<DocumentProcessingJobRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("document_processing_jobs")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })) as unknown as {
    data: DocumentProcessingJobRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}
