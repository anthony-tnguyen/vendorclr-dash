import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getRequestScopedClient, getServiceRoleClient } from "@/lib/supabase/serverClient.server";
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
 * Neither uploadDocumentForToken() nor anything downstream of it ever writes
 * to vendor_compliance_items. A received file is not evidence of compliance -
 * that determination is Phase 2/3 work (OCR, extraction, the compliance
 * engine). What this phase does on a successful upload is make the document
 * visible to staff: it appends a compliance_queue_items row, which is what the
 * existing admin Compliance Queue screen already reads from.
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
    });

    if (docError) throw new Error("Could not record the upload. Try again.");

    await supabase
      .from("vendor_upload_requests")
      .update({ status: "uploaded", uploaded_at: new Date().toISOString() })
      .eq("id", row.id);

    // Gives staff visibility through the admin Compliance Queue page, which
    // already reads compliance_queue_items - Phase 1 wires the upload into
    // that existing screen rather than building a new one.
    await supabase.from("compliance_queue_items").insert({
      company_id: row.company_id,
      vendor_id: row.vendor_id,
      document_label: file.name || "Uploaded certificate",
      state: "queued",
    });

    return { documentId };
  });
