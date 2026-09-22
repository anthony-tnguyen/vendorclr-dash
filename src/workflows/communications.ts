import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { renewalRequestHtml, renewalRequestSubject, renewalRequestText } from "./emailTemplates";
import { getEmailSender, type EmailSender } from "./emailSender";
import { outboxStatusFor, sendUnlessSuppressed } from "./suppression";
import { generateUploadToken, hashToken, newExpiryDate } from "./uploadTokens";

/**
 * sendRequest() - the only way the product sends a vendor a document
 * request. The vendor detail page's "Request documents" dialog, its resend
 * action, and the bulk importer's optional dispatch all call it; the old
 * single-recipient createUploadRequest() (which mailed vendors.contact_email
 * with no suppression check) no longer exists.
 *
 * Split in two:
 *
 *   public.prepare_contact_request() (SQL, SECURITY INVOKER - migration
 *   20260922120000) decides WHO. It re-derives the recipient list from
 *   vendor_contacts under the caller's own RLS: every id must be a contact
 *   of this company linked to this vendor or the whole call is rejected,
 *   suppressed addresses are excluded (and recorded as 'suppressed' outbox
 *   rows), an all-suppressed selection creates nothing, and a resend
 *   cancels the request it replaces. It inserts the new request with the
 *   token hash generated here.
 *
 *   sendRequestHandler() (below) generates a fresh token for every call -
 *   first send or resend, never reused - then mails exactly the recipients
 *   the database returned as eligible, re-checking suppression immediately
 *   before each send (sendUnlessSuppressed), and records one email_outbox
 *   row per recipient plus one audit_log row.
 *
 * Nothing about the recipient list is taken from the client beyond "these
 * contact ids": names, emails and roles all come back from the database.
 */

async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

function bareVendorUploadUrl(): string {
  const configured = import.meta.env["VITE_APP_URL"]?.trim();
  return (configured || "http://localhost:3000").replace(/\/+$/, "");
}

export const REQUEST_PURPOSES = ["renewal", "initial", "correction"] as const;
export type RequestPurpose = (typeof REQUEST_PURPOSES)[number];

export const sendRequestSchema = z.object({
  vendorId: z.string().uuid(),
  purpose: z.enum(REQUEST_PURPOSES).default("renewal"),
  /**
   * The contact ids the sender confirmed on screen. There is no "whoever
   * got the last one" shortcut: a resend passes its (possibly edited)
   * recipient list explicitly, like a first send.
   */
  confirmedRecipientIds: z.array(z.string().uuid()).min(1, "Select at least one recipient."),
  /** Set when this replaces an earlier request; that request's link is cancelled. */
  resendOfRequestId: z.string().uuid().optional(),
});

export type SendRequestInput = z.infer<typeof sendRequestSchema>;

export type SendRequestRecipientOutcome =
  "sent" | "failed" | "not_configured" | "skipped_suppressed";

export interface SendRequestRecipientResult {
  contactId: string;
  vendorContactId: string;
  name: string;
  email: string;
  organization: string;
  role: string;
  outcome: SendRequestRecipientOutcome;
  /** Every recipient, including a suppressed one, has an email_outbox row. */
  outboxId: string | null;
  error: string | null;
}

export interface SendRequestResult {
  requestId: string;
  uploadUrl: string;
  recipients: SendRequestRecipientResult[];
}

interface PreparedRecipient {
  contactId: string;
  vendorContactId: string;
  name: string;
  email: string;
  organization: string;
  role: string;
  suppressionReason: string | null;
}

interface PreparedRequest {
  requestId: string;
  companyId: string;
  vendorName: string;
  companyName: string;
  recipients: PreparedRecipient[];
}

export interface SendRequestDeps {
  sender?: EmailSender;
  /** Injectable so tests can prove each call mints its own token. */
  newToken?: () => string;
}

export async function sendRequestHandler(
  supabase: SupabaseClient,
  input: SendRequestInput,
  deps: SendRequestDeps = {},
): Promise<SendRequestResult> {
  const sender = deps.sender ?? getEmailSender();
  const token = (deps.newToken ?? generateUploadToken)();
  const tokenHash = await hashToken(token);

  const { data: prepared, error: prepareError } = await supabase.rpc("prepare_contact_request", {
    p_vendor_id: input.vendorId,
    p_contact_ids: input.confirmedRecipientIds,
    p_purpose: input.purpose,
    p_token_hash: tokenHash,
    p_expires_at: newExpiryDate().toISOString(),
    p_resend_of_request_id: input.resendOfRequestId ?? null,
  });

  if (prepareError || !prepared) {
    throw new Error(prepareError?.message ?? "Could not create the request.");
  }
  const request = prepared as unknown as PreparedRequest;
  const uploadUrl = `${bareVendorUploadUrl()}/vendor-upload/${token}`;

  const { data: policies } = await supabase
    .from("vendor_policies")
    .select("policy_type, carrier_name, policy_number, expiration_date")
    .eq("vendor_id", input.vendorId)
    .eq("status", "active");

  const currentPolicies = (
    (policies ?? []) as Array<{
      policy_type: string;
      carrier_name: string;
      policy_number: string;
      expiration_date: string | null;
    }>
  ).map((p) => ({
    policyType: p.policy_type,
    carrierName: p.carrier_name,
    policyNumber: p.policy_number,
    expirationDate: p.expiration_date,
  }));

  // Suppressed recipients already have their outbox row (written by
  // prepare_contact_request); look them up so the result can point at it.
  const { data: suppressedRows } = await supabase
    .from("email_outbox")
    .select("id, contact_id")
    .eq("upload_request_id", request.requestId)
    .eq("status", "suppressed");
  const suppressedOutbox = new Map(
    ((suppressedRows ?? []) as Array<{ id: string; contact_id: string | null }>).map((r) => [
      r.contact_id,
      r.id,
    ]),
  );

  const outcomes: SendRequestRecipientResult[] = [];
  let anySent = false;

  for (const recipient of request.recipients) {
    const base = {
      contactId: recipient.contactId,
      vendorContactId: recipient.vendorContactId,
      name: recipient.name,
      email: recipient.email,
      organization: recipient.organization,
      role: recipient.role,
    };

    if (recipient.suppressionReason) {
      outcomes.push({
        ...base,
        outcome: "skipped_suppressed",
        outboxId: suppressedOutbox.get(recipient.contactId) ?? null,
        error: `Suppressed (${recipient.suppressionReason})`,
      });
      continue;
    }

    const emailInput = {
      vendorContactName: recipient.name,
      vendorName: request.vendorName,
      companyName: request.companyName,
      uploadUrl,
      currentPolicies,
    };

    const sendResult = await sendUnlessSuppressed(
      supabase,
      request.companyId,
      {
        to: recipient.email,
        subject: renewalRequestSubject(emailInput),
        html: renewalRequestHtml(emailInput),
        text: renewalRequestText(emailInput),
      },
      sender,
    );

    const { data: outboxRow, error: outboxError } = await supabase
      .from("email_outbox")
      .insert({
        company_id: request.companyId,
        vendor_id: input.vendorId,
        upload_request_id: request.requestId,
        template: "renewal_request",
        to_email: recipient.email,
        contact_id: recipient.contactId,
        recipient_role: recipient.role,
        status: outboxStatusFor(sendResult),
        provider_message_id: sendResult.providerMessageId,
        error: sendResult.error,
        sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();

    if (outboxError) throw new Error(outboxError.message);
    if (sendResult.status === "sent") anySent = true;

    outcomes.push({
      ...base,
      outcome: sendResult.status === "suppressed" ? "skipped_suppressed" : sendResult.status,
      outboxId: (outboxRow as { id: string } | null)?.id ?? null,
      error: sendResult.error,
    });
  }

  if (anySent) {
    await supabase
      .from("vendor_upload_requests")
      .update({ status: "email_sent" })
      .eq("id", request.requestId)
      .eq("status", "pending");
  }

  await supabase.from("audit_log").insert({
    company_id: request.companyId,
    action: "contact_request_sent",
    target_type: "vendor",
    target_id: input.vendorId,
    detail: {
      requestId: request.requestId,
      purpose: input.purpose,
      resendOfRequestId: input.resendOfRequestId ?? null,
      recipients: outcomes.map((o) => ({
        contactId: o.contactId,
        role: o.role,
        outcome: o.outcome,
        outboxId: o.outboxId,
      })),
    },
  });

  return { requestId: request.requestId, uploadUrl, recipients: outcomes };
}

export const sendRequest = createServerFn({ method: "POST" })
  .validator(sendRequestSchema)
  .handler(async ({ data }): Promise<SendRequestResult> => {
    const supabase = await getRequestScopedClient();
    return sendRequestHandler(supabase as unknown as SupabaseClient, data);
  });
