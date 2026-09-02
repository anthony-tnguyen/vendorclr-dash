import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getRequestScopedClient, getServiceRoleClient } from "@/lib/supabase/serverClient.server";
import { getDocumentExtractor, type ExtractDocumentResult } from "./documentExtraction";
import { getEmailSender } from "./emailSender";
import { renewalRequestHtml, renewalRequestSubject, renewalRequestText } from "./emailTemplates";
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
 * Neither uploadDocumentForToken() nor reprocessDocument() nor anything
 * downstream of them ever writes to vendor_compliance_items or
 * vendor_policies. A received, even successfully-parsed, document is not
 * evidence of compliance - that determination (matching extracted data
 * against what a client actually requires) is Phase 3's compliance engine.
 * What this phase does is: store the file (Phase 1), then extract it into
 * structured, confidence-scored JSON and store *that* alongside it (Phase 2).
 * Extraction failing never fails the upload itself - the vendor still sees
 * "thanks, we received your document" even if extraction throws; the file is
 * safely stored regardless, and vendor_documents.processing_status records
 * what happened separately.
 */

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

    const { error: docError } = await supabase.from("vendor_documents").insert({
      id: documentId,
      company_id: row.company_id,
      vendor_id: row.vendor_id,
      upload_request_id: row.id,
      storage_path: storagePath,
      file_name: file.name || `certificate.${file.type.split("/")[1] ?? "pdf"}`,
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
    // that existing screen rather than building a new one.
    const { data: queueItem } = await supabase
      .from("compliance_queue_items")
      .insert({
        company_id: row.company_id,
        vendor_id: row.vendor_id,
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
 * Writes the extraction outcome onto vendor_documents, and - only when the
 * result needs a human look - nudges the matching compliance_queue_items row
 * from 'queued' to 'in-review' so it stands out on the existing admin screen.
 * A clean 'processed' result leaves the queue item exactly as Phase 1 left
 * it: a document still awaiting a person's own review, not auto-approved.
 */
async function applyExtractionResult(
  supabase: SupabaseClient,
  params: { documentId: string; queueItemId: string | null; extraction: ExtractDocumentResult },
): Promise<void> {
  const { documentId, queueItemId, extraction } = params;

  await supabase
    .from("vendor_documents")
    .update({
      processing_status: extraction.status === "not_configured" ? "failed" : extraction.status,
      parsed_data: extraction.data,
      extraction_confidence: extraction.confidence,
      processing_error: extraction.error,
      processed_at: new Date().toISOString(),
    })
    .eq("id", documentId);

  if (queueItemId && (extraction.status === "needs_review" || extraction.status === "failed")) {
    await supabase
      .from("compliance_queue_items")
      .update({ state: "in-review" })
      .eq("id", queueItemId);
  }
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
 * error). Runs entirely on the request-scoped client, not the service role:
 * the caller is a signed-in admin, not an anonymous vendor, so the same
 * can_write_company() RLS policy that gates every other vendor_documents
 * write gates this too - both the read that finds the document and the
 * write that records the new result. There is nothing here a service-role
 * bypass is needed for.
 */
export const reprocessDocument = createServerFn({ method: "POST" })
  .validator(reprocessDocumentSchema)
  .handler(async ({ data }): Promise<ReprocessDocumentResult> => {
    const supabase = getRequestScopedClient();

    const { data: doc, error: docError } = await supabase
      .from("vendor_documents")
      .select("id, storage_path, mime_type, vendor_id")
      .eq("id", data.documentId)
      .maybeSingle();

    if (docError || !doc) throw new Error("Document not found.");

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from("vendor-documents")
      .download(doc.storage_path);

    if (downloadError || !fileBlob) throw new Error("Could not read the stored file.");

    const fileBytes = await fileBlob.arrayBuffer();
    const extraction = await runExtractionSafely({ fileBytes, mimeType: doc.mime_type });

    // Approximate on purpose: compliance_queue_items has no document_id
    // column linking it back to a specific vendor_documents row, so this
    // takes the vendor's most recently created queue item rather than the
    // exact one this document produced. Fine for a single-document retry;
    // add that column before relying on this for a vendor with concurrent
    // uploads in flight.
    const { data: queueItem } = await supabase
      .from("compliance_queue_items")
      .select("id")
      .eq("vendor_id", doc.vendor_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    await applyExtractionResult(supabase, {
      documentId: doc.id,
      queueItemId: queueItem?.id ?? null,
      extraction,
    });

    return { status: extraction.status };
  });
