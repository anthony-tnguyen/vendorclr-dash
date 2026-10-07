import { createServerFn } from "@tanstack/react-start";

import type { VendorTrade } from "@/data/contracts";

import {
  isVendorTrade,
  proposalFromExtraction,
  type CoiVendorProposal,
  type ProposedPolicy,
} from "./coiIntakeMapping";
import { InsuranceExtractionSchema, type InsuranceExtraction } from "./insuranceExtractionSchema";
import { buildStoragePath, hashFileBytes } from "./uploadTokens";

/**
 * COI-driven vendor intake: the customer uploads certificates they already hold,
 * the extractor reads each one, and — after the customer reviews and supplies the
 * one field a COI never carries (trade) — a vendor, its policy lines and the
 * stored certificate are created in one confirm step.
 *
 * Reuses the same extractor the vendor-upload portal uses
 * (getDocumentExtractor). Runs server-side because extraction needs the
 * (server-only) Anthropic key; the server-only client and file-validation
 * modules are imported lazily inside handlers so nothing server-only lands in
 * the browser bundle, exactly as vendorUploadRequests.ts does.
 *
 * Authorization: parse only requires the caller to be a member of the workspace;
 * the create step inserts the vendor through the REQUEST-SCOPED client, so the
 * database's own can_write_company() RLS policy decides whether the caller may
 * write — never re-implemented here. Dependent rows (the document and policy
 * records) then go in under the service role, after that check has passed.
 */

async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

async function getServiceRoleClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getServiceRoleClient();
}

async function getFileValidationModule() {
  return import("./fileValidation.server");
}

async function getDocumentExtractionModule() {
  return import("./documentExtraction");
}

/** The caller's id and their single workspace, resolved from their own membership. */
async function resolveCaller(): Promise<{ userId: string; companyId: string }> {
  const supabase = await getRequestScopedClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be signed in.");

  const { data, error } = await supabase
    .from("company_members")
    .select("company_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This account has no workspace yet.");
  return { userId: user.id, companyId: data.company_id };
}

export interface ParsedCoiFile {
  storagePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
}

export interface ParseCoiResult {
  status: "processed" | "needs_review" | "failed" | "not_configured";
  confidence: number | null;
  error: string | null;
  extraction: InsuranceExtraction | null;
  proposal: CoiVendorProposal | null;
  file: ParsedCoiFile;
}

/**
 * Validate, extract and stage a single uploaded certificate. Nothing about the
 * vendor is written yet — the file is stored so the confirm step can link it
 * without a re-upload, and the extracted proposal is returned for review.
 */
export const parseCoiForIntake = createServerFn({ method: "POST" })
  .validator((formData: FormData) => formData)
  .handler(async ({ data: formData }): Promise<ParseCoiResult> => {
    const { companyId } = await resolveCaller();

    const file = formData.get("file");
    if (!(file instanceof File)) throw new Error("No file was provided.");

    const { validateUploadedFile, FileValidationError } = await getFileValidationModule();
    let validated;
    try {
      validated = await validateUploadedFile(file);
    } catch (error) {
      throw new Error(
        error instanceof FileValidationError
          ? error.message
          : "Could not read the uploaded file. Try again.",
      );
    }
    if (validated.encryptedPdf) {
      throw new Error("This PDF is password protected. Remove the password and re-upload it.");
    }

    const { bytes, detectedMime } = validated;
    const sha256 = await hashFileBytes(bytes);

    const { getDocumentExtractor } = await getDocumentExtractionModule();
    const extraction = await getDocumentExtractor().extract({
      fileBytes: bytes,
      mimeType: detectedMime,
    });

    // Stage the file under an "intake" path so confirm can reference it without
    // a second upload. The vendor_documents row created on confirm carries the
    // real vendor link; this path is server-controlled, never client-supplied.
    const documentId = crypto.randomUUID();
    const storagePath = buildStoragePath({
      companyId,
      vendorId: "intake",
      documentId,
      mimeType: detectedMime,
    });
    const service = await getServiceRoleClient();
    const { error: uploadError } = await service.storage
      .from("vendor-documents")
      .upload(storagePath, bytes, { contentType: detectedMime, upsert: false });
    if (uploadError) throw new Error("Could not store the file. Try again.");

    return {
      status: extraction.status,
      confidence: extraction.confidence,
      error: extraction.error,
      extraction: extraction.data,
      proposal: extraction.data ? proposalFromExtraction(extraction.data) : null,
      file: {
        storagePath,
        fileName: file.name || `certificate.${detectedMime.split("/")[1] ?? "pdf"}`,
        mimeType: detectedMime,
        fileSize: file.size,
        sha256,
      },
    };
  });

export interface ConfirmCoiItem {
  file: ParsedCoiFile;
  vendorName: string;
  trade: VendorTrade;
  riskTier: "low" | "moderate" | "high";
  contactName?: string;
  contactEmail?: string;
  project?: string;
  confidence: number | null;
  extraction: InsuranceExtraction | null;
  policies: ProposedPolicy[];
}

export interface ConfirmCoiResult {
  results: Array<{ vendorName: string; vendorId?: string; ok: boolean; error?: string }>;
}

/**
 * Create a vendor, its policy lines and the stored certificate for each reviewed
 * item. Each item is independent: one bad row does not fail the batch.
 */
export const createVendorsFromCoiIntake = createServerFn({ method: "POST" })
  .validator((input: { items: ConfirmCoiItem[] }) => input)
  .handler(async ({ data }): Promise<ConfirmCoiResult> => {
    const { companyId } = await resolveCaller();
    const rsc = await getRequestScopedClient();
    const service = await getServiceRoleClient();

    const results: ConfirmCoiResult["results"] = [];

    for (const item of data.items) {
      const name = item.vendorName.trim();
      try {
        if (!name) throw new Error("Vendor name is required.");
        if (!isVendorTrade(item.trade)) throw new Error("Choose a trade for this vendor.");
        const riskTier = ["low", "moderate", "high"].includes(item.riskTier)
          ? item.riskTier
          : "moderate";

        // Vendor insert runs as the caller — can_write_company() RLS is the
        // authorization gate. A read-only member is refused here.
        const { data: vendor, error: vendorError } = await rsc
          .from("vendors")
          .insert({
            company_id: companyId,
            name: name.slice(0, 200),
            trade: item.trade,
            risk_tier: riskTier,
            contact_name: item.contactName?.trim() ?? "",
            contact_email: item.contactEmail?.trim() ?? "",
            project: item.project?.trim() || "Unassigned",
          })
          .select("id")
          .single();
        if (vendorError || !vendor) {
          throw new Error(vendorError?.message ?? "Could not create the vendor.");
        }
        const vendorId = vendor.id;

        // Only store parsed_data that still validates the schema (the customer
        // may have edited it on the review screen).
        let parsed: InsuranceExtraction | null = null;
        if (item.extraction) {
          const check = InsuranceExtractionSchema.safeParse(item.extraction);
          parsed = check.success ? check.data : null;
        }
        const processingStatus =
          item.confidence != null && item.confidence < 0.8 ? "needs_review" : "processed";

        const { error: documentError } = await service.from("vendor_documents").insert({
          company_id: companyId,
          vendor_id: vendorId,
          storage_path: item.file.storagePath,
          file_name: item.file.fileName,
          mime_type: item.file.mimeType,
          file_size: item.file.fileSize,
          sha256: item.file.sha256,
          source: "client_upload",
          processing_status: processingStatus,
          parsed_data: parsed,
          extraction_confidence: item.confidence,
          processed_at: new Date().toISOString(),
        });
        if (documentError) throw new Error(documentError.message);

        if (item.policies.length > 0) {
          const { error: policyError } = await service.from("vendor_policies").insert(
            item.policies.map((policy) => ({
              company_id: companyId,
              vendor_id: vendorId,
              policy_type: policy.policyType,
              carrier_name: policy.carrier ?? "",
              policy_number: policy.policyNumber ?? "",
              effective_date: policy.effectiveDate,
              expiration_date: policy.expirationDate,
              each_occurrence_limit: policy.eachOccurrenceLimit,
              general_aggregate_limit: policy.generalAggregateLimit,
              additional_insured: policy.additionalInsured,
              waiver_of_subrogation: policy.waiverOfSubrogation,
              primary_noncontributory: policy.primaryNoncontributory,
              // Extraction is machine-read, so policies land as needs_review for
              // a human to verify, never silently "verified".
              verification_status: "needs_review",
            })),
          );
          if (policyError) throw new Error(policyError.message);
        }

        results.push({ vendorName: name, vendorId, ok: true });
      } catch (error) {
        results.push({
          vendorName: name || item.vendorName,
          ok: false,
          error: error instanceof Error ? error.message : "Could not create this vendor.",
        });
      }
    }

    return { results };
  });
