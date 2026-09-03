import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getRequestScopedClient, getServiceRoleClient } from "@/lib/supabase/serverClient.server";
import {
  computeComplianceItems,
  hasUnclassifiedPolicy,
  isGeneralLiability,
  matchExtractedPolicy,
  type ExistingPolicySnapshot,
  type RequirementSnapshot,
} from "./complianceEngine";
import { getDocumentExtractor, type ExtractDocumentResult } from "./documentExtraction";
import { getEmailSender } from "./emailSender";
import {
  adminReviewNeededHtml,
  adminReviewNeededSubject,
  adminReviewNeededText,
  documentReceivedHtml,
  documentReceivedSubject,
  documentReceivedText,
  renewalRequestHtml,
  renewalRequestSubject,
  renewalRequestText,
} from "./emailTemplates";
import type { ExtractedPolicy } from "./insuranceExtractionSchema";
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  buildStoragePath,
  canOpenRequest,
  canUploadToRequest,
  generateUploadToken,
  hashFileBytes,
  hashToken,
  isAllowedUploadMimeType,
  isExpired,
  MAX_UPLOAD_BYTES,
  newExpiryDate,
} from "./uploadTokens";

/**
 * The two server-function halves of the outbound vendor request system:
 *
 *   createUploadRequest   - called by a signed-in company member (the admin
 *                            dashboard). Runs as that user; RLS decides
 *                            whether they may act on this vendor.
 *   resolveUploadToken /
 *   uploadDocumentForToken - called by the anonymous vendor from the magic
 *                            link. No session exists to run these as, so they
 *                            use the service-role client and re-validate the
 *                            token by hand before touching anything.
 *
 * uploadDocumentForToken() and reprocessDocument() now go further than
 * storing and extracting a document: a `processed` extraction is run through
 * complianceEngine.ts's deterministic matching rule, and only a clean match -
 * same carrier, same policy number, a later expiration date, against an
 * existing active policy of that type - is applied to vendor_policies and
 * rolls the compliance rail forward. Everything else (a new carrier, a
 * changed policy number, a coverage type the vendor has never had before, an
 * unrecognized coverage type on the certificate) leaves vendor_policies and
 * vendor_compliance_items untouched and routes the document to
 * needs_review with a reason recorded on vendor_documents.review_reason.
 * Confidence (Phase 2) and this match (Phase 3) are independent gates - a
 * confident extraction that fails the match still needs a human decision.
 *
 * Extraction and matching failing never fails the upload itself - the vendor
 * still sees "thanks, we received your document" regardless; the file is
 * safely stored either way, and vendor_documents records what happened
 * separately.
 */

/**
 * Confirms the calling session belongs to VendorClear staff before a server
 * function drops from the request-scoped client to the service role.
 * is_platform_admin() runs through the request-scoped client so it is
 * decided by RLS/auth.uid() exactly as any other authenticated call would
 * be - this cannot be spoofed by a caller claiming to be an admin, only by
 * actually being one in platform_admins. Throws rather than returning a
 * boolean: every caller of this wants "stop here" on failure, not a value to
 * remember to check. Exported for documentReview.ts, which needs the same
 * check before its own service-role reads/writes.
 */
export async function assertPlatformAdmin(): Promise<void> {
  const supabase = getRequestScopedClient();
  const { data: isAdmin, error } = await supabase.rpc("is_platform_admin");
  if (error || !isAdmin) throw new Error("This action is limited to VendorClear staff accounts.");
}

function bareVendorUploadUrl(): string {
  // VITE_APP_URL is optional; local dev and same-origin deploys both work
  // without it since the link only needs to be correct once it's actually
  // sent, and getRequestUrl() would over-couple this to the calling request's
  // own host, which isn't necessarily the public one behind a proxy/CDN.
  const configured = import.meta.env["VITE_APP_URL"]?.trim();
  return (configured || "http://localhost:3000").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// createUploadRequest - authenticated, runs via RLS as the calling admin
// ---------------------------------------------------------------------------

const createUploadRequestSchema = z.object({
  vendorId: z.string().uuid(),
  purpose: z.enum(["renewal", "initial", "correction"]).default("renewal"),
});

export interface CreateUploadRequestResult {
  requestId: string;
  uploadUrl: string;
  email: {
    status: "sent" | "failed" | "not_configured";
    to: string;
  };
}

export const createUploadRequest = createServerFn({ method: "POST" })
  .validator(createUploadRequestSchema)
  .handler(async ({ data }): Promise<CreateUploadRequestResult> => {
    const supabase = getRequestScopedClient();

    const { data: vendor, error: vendorError } = await supabase
      .from("vendors")
      .select(
        "id, name, company_id, contact_name, contact_email, companies ( name ), " +
          "vendor_policies ( policy_type, carrier_name, policy_number, expiration_date, status )",
      )
      .eq("id", data.vendorId)
      .maybeSingle();

    // Any RLS failure and a genuine "no such vendor" collapse to the same
    // message: distinguishing them would let a caller probe for vendor ids
    // that exist in companies they don't belong to.
    if (vendorError || !vendor) {
      throw new Error("Vendor not found.");
    }
    const vendorRow = vendor as unknown as {
      id: string;
      name: string;
      company_id: string;
      contact_name: string;
      contact_email: string;
      companies: { name: string } | null;
      vendor_policies: Array<{
        policy_type: string;
        carrier_name: string;
        policy_number: string;
        expiration_date: string | null;
        status: string;
      }>;
    };

    if (!vendorRow.contact_email) {
      throw new Error("This vendor has no contact email on file.");
    }

    const token = generateUploadToken();
    const tokenHash = await hashToken(token);
    const expiresAt = newExpiryDate();

    // The INSERT is subject to vendor_upload_requests' RLS policy
    // (can_write_company), so a read-only member gets refused here, by the
    // database, not by a check written in this file.
    const { data: request, error: insertError } = await supabase
      .from("vendor_upload_requests")
      .insert({
        company_id: vendorRow.company_id,
        vendor_id: vendorRow.id,
        token_hash: tokenHash,
        purpose: data.purpose,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single();

    if (insertError || !request) {
      throw new Error(insertError?.message ?? "Could not create the upload request.");
    }

    const uploadUrl = `${bareVendorUploadUrl()}/vendor-upload/${token}`;

    const emailInput = {
      vendorContactName: vendorRow.contact_name,
      vendorName: vendorRow.name,
      companyName: vendorRow.companies?.name ?? "Your client",
      uploadUrl,
      currentPolicies: vendorRow.vendor_policies
        .filter((p) => p.status === "active")
        .map((p) => ({
          policyType: p.policy_type,
          carrierName: p.carrier_name,
          policyNumber: p.policy_number,
          expirationDate: p.expiration_date,
        })),
    };

    const sendResult = await getEmailSender().send({
      to: vendorRow.contact_email,
      subject: renewalRequestSubject(emailInput),
      html: renewalRequestHtml(emailInput),
      text: renewalRequestText(emailInput),
    });

    await supabase.from("email_outbox").insert({
      company_id: vendorRow.company_id,
      vendor_id: vendorRow.id,
      upload_request_id: request.id,
      template: "renewal_request",
      to_email: vendorRow.contact_email,
      status:
        sendResult.status === "sent"
          ? "sent"
          : sendResult.status === "failed"
            ? "failed"
            : "queued",
      provider_message_id: sendResult.providerMessageId,
      error: sendResult.error,
      sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
    });

    if (sendResult.status === "sent") {
      await supabase
        .from("vendor_upload_requests")
        .update({ status: "email_sent" })
        .eq("id", request.id);
    }

    return {
      requestId: request.id,
      uploadUrl,
      email: { status: sendResult.status, to: vendorRow.contact_email },
    };
  });

// ---------------------------------------------------------------------------
// resolveUploadToken - public, no session; service role after manual validation
// ---------------------------------------------------------------------------

export interface ResolvedUploadRequest {
  requestId: string;
  vendorName: string;
  companyName: string;
  expiresAt: string;
  currentPolicies: Array<{
    policyType: string;
    carrierName: string;
    policyNumber: string;
    expirationDate: string | null;
  }>;
}

const resolveUploadTokenSchema = z.object({ token: z.string().min(1) });

/** Thrown for every invalid-token case. Deliberately one message: telling an
 *  attacker "expired" vs "not found" vs "already used" narrows their guesses. */
const INVALID_TOKEN_MESSAGE = "This link is no longer valid. Ask your contact to send a new one.";

export const resolveUploadToken = createServerFn({ method: "GET" })
  .validator(resolveUploadTokenSchema)
  .handler(async ({ data }): Promise<ResolvedUploadRequest> => {
    const supabase = getServiceRoleClient();
    const tokenHash = await hashToken(data.token);

    const { data: request } = await supabase
      .from("vendor_upload_requests")
      .select(
        "id, status, expires_at, vendor_id, company_id, " +
          "vendors ( name, companies ( name ), vendor_policies ( policy_type, carrier_name, policy_number, expiration_date, status ) )",
      )
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (!request) throw new Error(INVALID_TOKEN_MESSAGE);

    const row = request as unknown as {
      id: string;
      status: string;
      expires_at: string;
      vendors: {
        name: string;
        companies: { name: string } | null;
        vendor_policies: Array<{
          policy_type: string;
          carrier_name: string;
          policy_number: string;
          expiration_date: string | null;
          status: string;
        }>;
      } | null;
    };

    if (isExpired(row.expires_at) || !canOpenRequest(row.status)) {
      throw new Error(INVALID_TOKEN_MESSAGE);
    }
    if (!row.vendors) throw new Error(INVALID_TOKEN_MESSAGE);

    if (row.status === "pending" || row.status === "email_sent") {
      await supabase
        .from("vendor_upload_requests")
        .update({ status: "opened", opened_at: new Date().toISOString() })
        .eq("id", row.id);
    }

    return {
      requestId: row.id,
      vendorName: row.vendors.name,
      companyName: row.vendors.companies?.name ?? "your client",
      expiresAt: row.expires_at,
      currentPolicies: row.vendors.vendor_policies
        .filter((p) => p.status === "active")
        .map((p) => ({
          policyType: p.policy_type,
          carrierName: p.carrier_name,
          policyNumber: p.policy_number,
          expirationDate: p.expiration_date,
        })),
    };
  });

// ---------------------------------------------------------------------------
// uploadDocumentForToken - public, no session; service role after manual validation
// ---------------------------------------------------------------------------

export interface UploadDocumentResult {
  documentId: string;
}

export const uploadDocumentForToken = createServerFn({ method: "POST" })
  .validator((formData: FormData) => formData)
  .handler(async ({ data: formData }): Promise<UploadDocumentResult> => {
    const token = formData.get("token");
    const file = formData.get("file");

    if (typeof token !== "string" || !token) throw new Error(INVALID_TOKEN_MESSAGE);
    if (!(file instanceof File)) throw new Error("No file was attached.");

    if (!isAllowedUploadMimeType(file.type)) {
      throw new Error(
        `Unsupported file type. Upload a PDF, JPG or PNG. Allowed: ${ALLOWED_UPLOAD_MIME_TYPES.join(", ")}.`,
      );
    }
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`File must be under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`);
    }

    const supabase = getServiceRoleClient();
    const tokenHash = await hashToken(token);

    const { data: request } = await supabase
      .from("vendor_upload_requests")
      .select("id, status, expires_at, vendor_id, company_id, vendors ( name )")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (!request) throw new Error(INVALID_TOKEN_MESSAGE);

    const row = request as unknown as {
      id: string;
      status: string;
      expires_at: string;
      vendor_id: string;
      company_id: string;
      vendors: { name: string } | null;
    };

    if (isExpired(row.expires_at) || !canUploadToRequest(row.status)) {
      throw new Error(INVALID_TOKEN_MESSAGE);
    }

    const bytes = await file.arrayBuffer();
    const sha256 = await hashFileBytes(bytes);

    // documentId is generated before the object is written so the storage path
    // and the vendor_documents row it will be inserted under always agree -
    // never derived from the client-supplied file name.
    const documentId = crypto.randomUUID();
    const storagePath = buildStoragePath({
      companyId: row.company_id,
      vendorId: row.vendor_id,
      documentId,
      mimeType: file.type,
    });

    // Checked before inserting, scoped per vendor rather than globally - the
    // same COI legitimately gets re-uploaded for different vendors (a
    // broker's template). If an earlier upload for this vendor already has a
    // successful extraction, that result is copied instead of paying for a
    // second identical extraction call.
    const { data: existingDuplicate } = await supabase
      .from("vendor_documents")
      .select("id, processing_status, parsed_data, extraction_confidence")
      .eq("vendor_id", row.vendor_id)
      .eq("sha256", sha256)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const { error: uploadError } = await supabase.storage
      .from("vendor-documents")
      .upload(storagePath, bytes, { contentType: file.type, upsert: false });

    if (uploadError) throw new Error("Could not store the file. Try again.");

    // Shared with the applyExtractionResult() call below, so the admin
    // notification email names exactly the file this row records - not a
    // second, independently-computed fallback that could drift from it.
    const fileName = file.name || `certificate.${file.type.split("/")[1] ?? "pdf"}`;

    const { error: docError } = await supabase.from("vendor_documents").insert({
      id: documentId,
      company_id: row.company_id,
      vendor_id: row.vendor_id,
      upload_request_id: row.id,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: file.type,
      file_size: file.size,
      sha256,
      source: "vendor_portal",
      duplicate_of_document_id: existingDuplicate?.id ?? null,
    });

    if (docError) throw new Error("Could not record the upload. Try again.");

    await supabase
      .from("vendor_upload_requests")
      .update({ status: "uploaded", uploaded_at: new Date().toISOString() })
      .eq("id", row.id);

    // Gives staff visibility through the admin Compliance Queue page, which
    // already reads compliance_queue_items - Phase 1 wires the upload into
    // that existing screen rather than building a new one. document_id links
    // this row back to the exact document it was created for (migration 12) -
    // reprocessDocument() and the review screen both rely on this being exact,
    // not an approximation.
    const { data: queueItem } = await supabase
      .from("compliance_queue_items")
      .insert({
        company_id: row.company_id,
        vendor_id: row.vendor_id,
        document_id: documentId,
        document_label: file.name || "Uploaded certificate",
        state: "queued",
      })
      .select("id")
      .single();

    // Duplicate of an already-successfully-processed document: reuse its
    // result rather than re-running extraction. Any other outcome (no
    // duplicate, or the duplicate itself never finished processing) runs a
    // fresh extraction below.
    const reusableDuplicate =
      existingDuplicate?.processing_status === "processed" ? existingDuplicate : null;

    const extraction = reusableDuplicate
      ? ({
          status: "processed",
          data: reusableDuplicate.parsed_data,
          confidence: reusableDuplicate.extraction_confidence,
          error: null,
        } as ExtractDocumentResult)
      : await runExtractionSafely({ fileBytes: bytes, mimeType: file.type });

    await applyExtractionResult(supabase, {
      documentId,
      companyId: row.company_id,
      vendorId: row.vendor_id,
      documentFileName: fileName,
      queueItemId: queueItem?.id ?? null,
      extraction,
    });

    return { documentId };
  });

/**
 * Never throws. A failure here must not fail the upload the vendor is
 * waiting on - the file is already safely stored by the time this runs, and
 * a bad network call to the extraction provider is not the vendor's problem.
 */
async function runExtractionSafely(input: {
  fileBytes: ArrayBuffer;
  mimeType: string;
}): Promise<ExtractDocumentResult> {
  try {
    return await getDocumentExtractor().extract(input);
  } catch (error) {
    return {
      status: "failed",
      data: null,
      confidence: null,
      error: error instanceof Error ? error.message : "Unknown extraction error",
    };
  }
}

/**
 * Applies matchExtractedPolicy() to every classified policy in an extraction
 * independently - a certificate listing GL + WC + Auto can cleanly renew GL
 * while WC needs a human look, and each should be judged on its own rather
 * than gating the whole document on the least-clean line item. Only the
 * general-liability outcome, when it renews cleanly, recomputes the
 * compliance rail: primaryPolicy() in supabaseRepository.ts already treats
 * GL as the vendor's flagship policy for the same reason, and coi/
 * additionalInsured/waiverOfSubrogation/renewal are specifically about that
 * policy, not "any coverage of any kind."
 *
 * Returns whether every policy on the certificate matched cleanly - false
 * downgrades the document's processing_status from 'processed' to
 * 'needs_review' in applyExtractionResult(), and the reasons collected here
 * become vendor_documents.review_reason.
 */
/**
 * Every active policy for a vendor, keyed by policy_type - the "what's on
 * file right now" side of a match decision. Exported so documentReview.ts
 * (the human-review approve action) reads the exact same shape as the
 * automated path, via a fresh read rather than trusting anything cached from
 * whenever the document was originally uploaded.
 */
export async function fetchActivePoliciesByType(
  supabase: SupabaseClient,
  vendorId: string,
): Promise<Map<string, ExistingPolicySnapshot>> {
  const { data: activePolicies } = await supabase
    .from("vendor_policies")
    .select("id, policy_type, carrier_name, policy_number, expiration_date")
    .eq("vendor_id", vendorId)
    .eq("status", "active");

  return new Map<string, ExistingPolicySnapshot>(
    (
      (activePolicies ?? []) as Array<{
        id: string;
        policy_type: string;
        carrier_name: string;
        policy_number: string;
        expiration_date: string | null;
      }>
    ).map((p) => [
      p.policy_type,
      {
        id: p.id,
        carrierName: p.carrier_name,
        policyNumber: p.policy_number,
        expirationDate: p.expiration_date,
      },
    ]),
  );
}

/** vendor_policies' column names -> ExtractedPolicy["limits"]'s key names - see RequirementSnapshot's docblock in complianceEngine.ts for why this translation lives here, not there. */
const LIMIT_FIELD_TO_EXTRACTED_KEY: Record<string, RequirementSnapshot["limitField"]> = {
  each_occurrence_limit: "each_occurrence",
  general_aggregate_limit: "general_aggregate",
};

/**
 * The company's coverage requirements (migration 13), grouped by
 * policy_type - the "what does this company require" side of a match
 * decision, company-wide rather than per-vendor (see the migration's
 * docblock for why). Not exported for reuse by documentReview.ts on
 * purpose: the human-review approve path deliberately does not check
 * requirements - see resolveReviewItem()'s own docblock.
 */
async function fetchRequirementsByType(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, RequirementSnapshot[]>> {
  const { data: requirements } = await supabase
    .from("compliance_requirements")
    .select("label, policy_type, limit_field, required_amount")
    .eq("company_id", companyId);

  const byType = new Map<string, RequirementSnapshot[]>();
  for (const req of (requirements ?? []) as Array<{
    label: string;
    policy_type: string;
    limit_field: string;
    required_amount: number;
  }>) {
    const limitField = LIMIT_FIELD_TO_EXTRACTED_KEY[req.limit_field];
    if (!limitField) continue; // Defensive only - the DB CHECK constraint already limits this to two values.
    const snapshot: RequirementSnapshot = {
      label: req.label,
      limitField,
      requiredAmount: req.required_amount,
    };
    const existing = byType.get(req.policy_type);
    if (existing) existing.push(snapshot);
    else byType.set(req.policy_type, [snapshot]);
  }
  return byType;
}

/**
 * Writes one classified extracted policy to vendor_policies via
 * apply_policy_renewal() - superseding existingPolicyId if given, inserting
 * fresh otherwise (apply_policy_renewal's UPDATE is a no-op against a null
 * id, so "no existing policy of this type" and "renew this one" are both
 * just a matter of what's passed here) - and, for general liability only,
 * recomputes the compliance rail. The one piece of writing logic both the
 * automated match path (applyComplianceEngine, below) and the human-review
 * approval path (documentReview.ts) share; they differ only in *which*
 * lines they call this for; see the callers, not the docblock, for that.
 */
export async function applyOnePolicyLine(
  supabase: SupabaseClient,
  params: {
    companyId: string;
    vendorId: string;
    existingPolicyId: string | null;
    policy: ExtractedPolicy & { type: NonNullable<ExtractedPolicy["type"]> };
  },
): Promise<{ newPolicyId: string } | { error: string }> {
  const { companyId, vendorId, existingPolicyId, policy } = params;

  const { data: newPolicyId, error: rpcError } = await supabase.rpc("apply_policy_renewal", {
    p_company_id: companyId,
    p_vendor_id: vendorId,
    p_existing_policy_id: existingPolicyId,
    p_policy_type: policy.type,
    p_carrier_name: policy.carrier,
    p_policy_number: policy.policy_number,
    p_effective_date: policy.effective_date,
    p_expiration_date: policy.expiration_date,
    p_each_occurrence_limit: policy.limits.each_occurrence ?? null,
    p_general_aggregate_limit: policy.limits.general_aggregate ?? null,
    p_additional_insured: policy.additional_insured,
    p_waiver_of_subrogation: policy.waiver_of_subrogation,
  });

  if (rpcError || !newPolicyId) {
    return { error: rpcError?.message ?? "apply_policy_renewal returned no id" };
  }

  if (isGeneralLiability(policy.type)) {
    const items = computeComplianceItems({
      isPrimaryPolicy: true,
      expirationDate: policy.expiration_date,
      additionalInsured: policy.additional_insured,
      waiverOfSubrogation: policy.waiver_of_subrogation,
    });

    await supabase.from("vendor_compliance_items").upsert(
      (Object.keys(items) as Array<keyof typeof items>).map((key) => ({
        company_id: companyId,
        vendor_id: vendorId,
        requirement_key: key,
        status: items[key].status,
        effective_date: items[key].effectiveDate,
        note: items[key].note ?? null,
      })),
      { onConflict: "vendor_id,requirement_key" },
    );
  }

  return { newPolicyId: newPolicyId as string };
}

async function applyComplianceEngine(
  supabase: SupabaseClient,
  params: { companyId: string; vendorId: string; policies: ExtractedPolicy[] },
): Promise<{ allMatched: boolean; appliedPolicyId: string | null; reasons: string[] }> {
  const { companyId, vendorId, policies } = params;
  const reasons: string[] = [];
  let appliedPolicyId: string | null = null;
  let allMatched = true;

  if (hasUnclassifiedPolicy(policies)) {
    allMatched = false;
    reasons.push("The certificate lists a coverage type that could not be classified.");
  }

  const classified = policies.filter(
    (p): p is ExtractedPolicy & { type: NonNullable<ExtractedPolicy["type"]> } => p.type !== null,
  );
  if (classified.length === 0) return { allMatched, appliedPolicyId, reasons };

  const [existingByType, requirementsByType] = await Promise.all([
    fetchActivePoliciesByType(supabase, vendorId),
    fetchRequirementsByType(supabase, companyId),
  ]);

  for (const extracted of classified) {
    const outcome = matchExtractedPolicy(
      extracted,
      existingByType.get(extracted.type) ?? null,
      requirementsByType.get(extracted.type) ?? [],
    );

    if (outcome.kind !== "renew") {
      allMatched = false;
      reasons.push(
        outcome.kind === "new_coverage"
          ? `${extracted.type}: no existing policy on file to renew against - first submission for this coverage type needs review.`
          : `${extracted.type}: ${outcome.reason}`,
      );
      continue;
    }

    const result = await applyOnePolicyLine(supabase, {
      companyId,
      vendorId,
      existingPolicyId: outcome.existingPolicyId,
      policy: extracted,
    });

    if ("error" in result) {
      allMatched = false;
      reasons.push(
        `${extracted.type}: matched cleanly but the database update failed - try reprocessing.`,
      );
      continue;
    }

    if (isGeneralLiability(extracted.type)) {
      appliedPolicyId = result.newPolicyId;
    } else if (appliedPolicyId === null) {
      appliedPolicyId = result.newPolicyId;
    }
  }

  return { allMatched, appliedPolicyId, reasons };
}

/**
 * Emails the vendor (always, whatever the outcome) and the company's owner(s)
 * (only when a human needs to act). Never throws - a bad send must not undo
 * the extraction/compliance-engine work that already committed, the same
 * principle runExtractionSafely() applies one layer up. Every attempt is
 * still recorded in email_outbox, including a failed one, matching
 * createUploadRequest()'s pattern exactly.
 */
async function notifyDocumentOutcome(
  supabase: SupabaseClient,
  params: {
    companyId: string;
    vendorId: string;
    documentFileName: string;
    finalStatus: "processed" | "needs_review" | "failed";
    reviewReason: string | null;
    processingError: string | null;
  },
): Promise<void> {
  try {
    const { data: vendorRow } = await supabase
      .from("vendors")
      .select("name, contact_name, contact_email, companies ( name )")
      .eq("id", params.vendorId)
      .maybeSingle();

    const vendor = vendorRow as unknown as {
      name: string;
      contact_name: string;
      contact_email: string;
      companies: { name: string } | null;
    } | null;

    if (vendor?.contact_email) {
      const sender = getEmailSender();
      const emailInput = {
        vendorContactName: vendor.contact_name ?? "",
        vendorName: vendor.name,
        companyName: vendor.companies?.name ?? "your client",
        outcome: params.finalStatus,
      };
      const sendResult = await sender.send({
        to: vendor.contact_email,
        subject: documentReceivedSubject(emailInput),
        html: documentReceivedHtml(emailInput),
        text: documentReceivedText(emailInput),
      });
      await supabase.from("email_outbox").insert({
        company_id: params.companyId,
        vendor_id: params.vendorId,
        template: "document_received",
        to_email: vendor.contact_email,
        status:
          sendResult.status === "sent"
            ? "sent"
            : sendResult.status === "failed"
              ? "failed"
              : "queued",
        provider_message_id: sendResult.providerMessageId,
        error: sendResult.error,
        sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
      });
    }

    if (params.finalStatus === "needs_review" || params.finalStatus === "failed") {
      const { data: owners } = await supabase
        .from("company_members")
        .select("profiles ( email )")
        .eq("company_id", params.companyId)
        .eq("role", "owner");

      const ownerEmails = (
        (owners ?? []) as unknown as Array<{ profiles: { email: string } | null }>
      )
        .map((row) => row.profiles?.email)
        .filter((email): email is string => Boolean(email));

      if (ownerEmails.length > 0) {
        const sender = getEmailSender();
        const emailInput = {
          vendorName: vendor?.name ?? "A vendor",
          documentFileName: params.documentFileName,
          outcome: params.finalStatus,
          reason: params.reviewReason ?? params.processingError,
        };
        for (const to of ownerEmails) {
          const sendResult = await sender.send({
            to,
            subject: adminReviewNeededSubject(emailInput),
            html: adminReviewNeededHtml(emailInput),
            text: adminReviewNeededText(emailInput),
          });
          await supabase.from("email_outbox").insert({
            company_id: params.companyId,
            vendor_id: params.vendorId,
            template: "admin_review_needed",
            to_email: to,
            status:
              sendResult.status === "sent"
                ? "sent"
                : sendResult.status === "failed"
                  ? "failed"
                  : "queued",
            provider_message_id: sendResult.providerMessageId,
            error: sendResult.error,
            sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
          });
        }
      }
    }
  } catch {
    // A notification failure must never surface as an upload/reprocess
    // failure - the document was already stored and its status already
    // recorded. Nothing useful to do with the error here beyond not letting
    // it propagate; the missing email_outbox row is itself the visible trace.
  }
}

/**
 * Writes the extraction outcome onto vendor_documents, and - only when the
 * result needs a human look - nudges the matching compliance_queue_items row
 * from 'queued' to 'in-review' so it stands out on the existing admin screen.
 * A clean 'processed' result leaves the queue item exactly as Phase 1 left
 * it: a document still awaiting a person's own review, not auto-approved.
 *
 * A 'processed' extraction is downgraded to 'needs_review' here, after the
 * fact, if applyComplianceEngine() could not cleanly apply every policy on
 * the certificate - confidence and the deterministic match are independent
 * gates, and a document must clear both to count as processed.
 */
async function applyExtractionResult(
  supabase: SupabaseClient,
  params: {
    documentId: string;
    companyId: string;
    vendorId: string;
    documentFileName: string;
    queueItemId: string | null;
    extraction: ExtractDocumentResult;
  },
): Promise<void> {
  const { documentId, companyId, vendorId, documentFileName, queueItemId, extraction } = params;

  let finalStatus = extraction.status === "not_configured" ? "failed" : extraction.status;
  let reviewReason: string | null = null;
  let appliedPolicyId: string | null = null;

  if (extraction.status === "processed" && extraction.data) {
    const result = await applyComplianceEngine(supabase, {
      companyId,
      vendorId,
      policies: extraction.data.policies,
    });
    appliedPolicyId = result.appliedPolicyId;
    if (!result.allMatched) {
      finalStatus = "needs_review";
      reviewReason = result.reasons.join(" ");
    }
  }

  await supabase
    .from("vendor_documents")
    .update({
      processing_status: finalStatus,
      parsed_data: extraction.data,
      extraction_confidence: extraction.confidence,
      processing_error: extraction.error,
      review_reason: reviewReason,
      applied_policy_id: appliedPolicyId,
      processed_at: new Date().toISOString(),
    })
    .eq("id", documentId);

  if (queueItemId && (finalStatus === "needs_review" || finalStatus === "failed")) {
    await supabase
      .from("compliance_queue_items")
      .update({ state: "in-review" })
      .eq("id", queueItemId);
  }

  await notifyDocumentOutcome(supabase, {
    companyId,
    vendorId,
    documentFileName,
    finalStatus,
    reviewReason,
    processingError: extraction.error,
  });
}

// ---------------------------------------------------------------------------
// reprocessDocument - authenticated, runs via RLS as the calling admin
// ---------------------------------------------------------------------------

const reprocessDocumentSchema = z.object({ documentId: z.string().uuid() });

export interface ReprocessDocumentResult {
  status: ExtractDocumentResult["status"];
}

/**
 * Manual retry for a document whose extraction previously came back
 * `not_configured` (no ANTHROPIC_API_KEY yet) or `failed` (a transient
 * error).
 *
 * Runs on the SERVICE role, after independently confirming the caller is a
 * platform admin - not the request-scoped client the docblock here used to
 * claim was sufficient. That was wrong: the only screen that can ever call
 * this (the admin Compliance Queue / review screen, AdminGuard-gated on
 * `role === "admin"`) is staff-only, and `can_write_company()` grants write
 * access by *company membership*, which VendorClear staff reviewing a
 * customer's documents do not have. `vendor_documents_update`,
 * `compliance_queue_items_write`, and `apply_policy_renewal()` (deliberately
 * not security definer) all gate on `can_write_company()`/company
 * membership with no platform-admin bypass - so this previously either threw
 * under RLS or silently updated nothing for the only caller that could ever
 * reach it. assertPlatformAdmin() re-validates the caller server-side via
 * RLS (is_platform_admin() cannot be spoofed) before this drops to the
 * service role, the same "validate identity, then act unrestricted" shape
 * already used for the anonymous vendor-portal endpoints, just with a
 * session check instead of a token hash.
 */
export const reprocessDocument = createServerFn({ method: "POST" })
  .validator(reprocessDocumentSchema)
  .handler(async ({ data }): Promise<ReprocessDocumentResult> => {
    await assertPlatformAdmin();
    const supabase = getServiceRoleClient();

    const { data: doc, error: docError } = await supabase
      .from("vendor_documents")
      .select("id, storage_path, mime_type, vendor_id, company_id, file_name")
      .eq("id", data.documentId)
      .maybeSingle();

    if (docError || !doc) throw new Error("Document not found.");

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from("vendor-documents")
      .download(doc.storage_path);

    if (downloadError || !fileBlob) throw new Error("Could not read the stored file.");

    const fileBytes = await fileBlob.arrayBuffer();
    const extraction = await runExtractionSafely({ fileBytes, mimeType: doc.mime_type });

    // Exact now (migration 12), not an approximation: the queue item that
    // named this document when it was created, not "whichever one the
    // vendor most recently touched" - matters once a vendor has more than
    // one upload in flight.
    const { data: queueItem } = await supabase
      .from("compliance_queue_items")
      .select("id")
      .eq("document_id", doc.id)
      .maybeSingle();

    await applyExtractionResult(supabase, {
      documentId: doc.id,
      companyId: doc.company_id,
      vendorId: doc.vendor_id,
      documentFileName: doc.file_name,
      queueItemId: queueItem?.id ?? null,
      extraction,
    });

    return { status: extraction.status };
  });
