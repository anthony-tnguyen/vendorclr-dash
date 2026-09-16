import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { renewalRequestHtml, renewalRequestSubject, renewalRequestText } from "./emailTemplates";
import { getEmailSender } from "./emailSender";
import { generateUploadToken, hashToken, newExpiryDate } from "./uploadTokens";

/**
 * sendRequest() - the multi-recipient generalization of
 * createUploadRequest() (vendorUploadRequests.ts): where that function
 * always sends to exactly one address (vendors.contact_email), this sends
 * to any set of the vendor's linked contacts (Task 7 - contacts/
 * vendor_contacts, 20260916000600_contacts_and_suppression.sql), skipping
 * anyone currently suppressed, and writes one email_outbox row per
 * recipient actually sent to.
 *
 * Lives in src/workflows/ rather than src/server/ for the same reason
 * every other server-only module in this project does: this repo's Vite
 * config blocks src/server/** from the client bundle, and this file (like
 * vendorUploadRequests.ts) needs to be importable from a route/component
 * tree that also runs on the client, via createServerFn()'s isomorphic
 * wrapper.
 *
 * Design decision - shared helper vs. duplication with createUploadRequest():
 * this function deliberately does NOT import or refactor anything out of
 * vendorUploadRequests.ts. createUploadRequest() is out of scope to modify
 * (task instructions), and the token-generation-and-insert sequence this
 * function needs is four calls (generateUploadToken/hashToken/
 * newExpiryDate, then one insert into vendor_upload_requests) - genuinely
 * small enough that extracting a shared helper would mean either editing
 * vendorUploadRequests.ts (to export the pieces) or introducing a third
 * module both import from, for a handful of lines that are unlikely to
 * drift silently (they are both directly against the same table shape,
 * covered by this project's own migration-level checks). Duplicating those
 * few lines here keeps this file fully self-contained and leaves
 * createUploadRequest() byte-for-byte untouched, which was the higher
 * priority given the explicit "don't touch its behavior/signature or file"
 * instruction.
 */

async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

/** Same construction as vendorUploadRequests.ts's private bareVendorUploadUrl() - duplicated rather than imported, since that function is not exported and this file does not touch that one. */
function bareVendorUploadUrl(): string {
  const configured = import.meta.env["VITE_APP_URL"]?.trim();
  return (configured || "http://localhost:3000").replace(/\/+$/, "");
}

const sendRequestSchema = z.object({
  vendorId: z.string().uuid(),
  purpose: z.enum(["renewal", "initial", "correction"]).default("renewal"),
  /**
   * Deliberately named confirmedRecipientIds, not recipientIds or
   * "resend" - the plan's "resend requires recipient confirmation" is
   * enforced by this being the ONLY way to name who receives the new
   * request. There is no "resend to whoever was on the previous request"
   * shortcut anywhere in this function: every call, first send or resend,
   * must pass the contact ids it actually wants emailed right now. A
   * future UI's resend action should re-show the previous recipients for
   * the human to confirm (or edit) before calling this, not read them off
   * the old request and pass them through silently.
   *
   * Each id is a contacts.id that must be linked to this vendor via
   * vendor_contacts - verified server-side below, not trusted from the
   * caller.
   */
  confirmedRecipientIds: z.array(z.string().uuid()).min(1, "Select at least one recipient."),
});

export type SendRequestRecipientOutcome =
  "sent" | "failed" | "queued" | "not_configured" | "skipped_suppressed";

export interface SendRequestRecipientResult {
  contactId: string;
  vendorContactId: string;
  email: string;
  role: string;
  outcome: SendRequestRecipientOutcome;
  /** null when the recipient was skipped (suppressed) - no email_outbox row is written for a skip. */
  outboxId: string | null;
}

export interface SendRequestResult {
  requestId: string;
  uploadUrl: string;
  recipients: SendRequestRecipientResult[];
}

/**
 * Sends (or resends, via a brand-new request/token - see the schema
 * docblock above) an upload request to a chosen set of a vendor's linked
 * contacts. Runs on the request-scoped client, exactly like
 * createUploadRequest(): RLS (can_write_company via vendor_upload_requests'
 * insert policy) decides whether the caller may act on this vendor, not an
 * application-level check.
 *
 * Never fails the whole call because one recipient is suppressed or one
 * send fails - each recipient gets its own outcome, mirroring how
 * createUploadRequest() already treats a failed send as a recorded outcome
 * rather than a thrown error. Throws only for input/vendor-not-found
 * problems that apply to the request as a whole.
 */
export const sendRequest = createServerFn({ method: "POST" })
  .validator(sendRequestSchema)
  .handler(async ({ data }): Promise<SendRequestResult> => {
    const supabase = await getRequestScopedClient();

    const { data: vendor, error: vendorError } = await supabase
      .from("vendors")
      .select(
        "id, name, company_id, companies ( name ), " +
          "vendor_policies ( policy_type, carrier_name, policy_number, expiration_date, status )",
      )
      .eq("id", data.vendorId)
      .maybeSingle();

    // Same collapse as createUploadRequest(): an RLS failure and a genuine
    // "no such vendor" must look identical to the caller.
    if (vendorError || !vendor) {
      throw new Error("Vendor not found.");
    }
    const vendorRow = vendor as unknown as {
      id: string;
      name: string;
      company_id: string;
      companies: { name: string } | null;
      vendor_policies: Array<{
        policy_type: string;
        carrier_name: string;
        policy_number: string;
        expiration_date: string | null;
        status: string;
      }>;
    };

    // The confirmed recipient ids must actually be linked to THIS vendor -
    // scoping by vendor_id here, not just trusting that the ids are
    // contacts the caller's company can see. RLS on contacts/vendor_contacts
    // only proves company membership; it says nothing about whether a given
    // contact is meant to receive mail for this particular vendor, and a
    // caller could otherwise pass an arbitrary company contact id along with
    // a vendorId it has nothing to do with.
    const { data: links, error: linksError } = await supabase
      .from("vendor_contacts")
      .select("id, role, contacts ( id, name, email )")
      .eq("vendor_id", data.vendorId)
      .in("contact_id", data.confirmedRecipientIds);

    if (linksError) throw new Error(linksError.message);

    const recipients = (
      (links ?? []) as unknown as Array<{
        id: string;
        role: string;
        contacts: { id: string; name: string; email: string } | null;
      }>
    ).filter(
      (row): row is typeof row & { contacts: NonNullable<(typeof row)["contacts"]> } =>
        row.contacts !== null,
    );

    if (recipients.length === 0) {
      throw new Error("None of the confirmed recipients are linked to this vendor.");
    }

    // Fresh token every call - never reuses or extends a prior
    // vendor_upload_requests row, mirroring cancelUploadRequest()'s own
    // "the old request stays exactly what it was" discipline. A resend is
    // a brand new request the old magic link cannot be revived into.
    const token = generateUploadToken();
    const tokenHash = await hashToken(token);
    const expiresAt = newExpiryDate();

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

    const currentPolicies = vendorRow.vendor_policies
      .filter((p) => p.status === "active")
      .map((p) => ({
        policyType: p.policy_type,
        carrierName: p.carrier_name,
        policyNumber: p.policy_number,
        expirationDate: p.expiration_date,
      }));

    const outcomes: SendRequestRecipientResult[] = [];
    let anySent = false;

    for (const link of recipients) {
      const contact = link.contacts;
      const normalizedEmail = contact.email.trim().toLowerCase();

      // Suppression check - the "automated sends skip suppressed
      // recipients" checklist item. Checked per recipient, immediately
      // before that recipient's send, not once up front: keeps the logic
      // simple (one recipient, one decision) and correct even if this loop
      // is ever parallelized later.
      const { data: suppression, error: suppressionError } = await supabase
        .from("suppressed_recipients")
        .select("id")
        .eq("company_id", vendorRow.company_id)
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (suppressionError) throw new Error(suppressionError.message);

      if (suppression) {
        const { logOperational, newRequestId } = await import("@/lib/observability/logger.server");
        logOperational(
          {
            level: "warn",
            event: "send_request_skipped_suppressed_recipient",
            requestId: newRequestId(),
            companyId: vendorRow.company_id,
            outcome: "failure",
          },
          // contact.email deliberately not logged raw here - logOperational's
          // own redaction (EMAIL_PATTERN) would strip it from `extra` anyway,
          // but the vendorContactId is enough for operations to look the
          // skip up without needing the address to appear in log output at
          // all.
          { vendorId: vendorRow.id, vendorContactId: link.id },
        );

        outcomes.push({
          contactId: contact.id,
          vendorContactId: link.id,
          email: contact.email,
          role: link.role,
          outcome: "skipped_suppressed",
          outboxId: null,
        });
        continue;
      }

      const emailInput = {
        vendorContactName: contact.name,
        vendorName: vendorRow.name,
        companyName: vendorRow.companies?.name ?? "Your client",
        uploadUrl,
        currentPolicies,
      };

      const sendResult = await getEmailSender().send({
        to: contact.email,
        subject: renewalRequestSubject(emailInput),
        html: renewalRequestHtml(emailInput),
        text: renewalRequestText(emailInput),
      });

      const outboxStatus =
        sendResult.status === "sent"
          ? "sent"
          : sendResult.status === "failed"
            ? "failed"
            : "queued";

      const { data: outboxRow, error: outboxError } = await supabase
        .from("email_outbox")
        .insert({
          company_id: vendorRow.company_id,
          vendor_id: vendorRow.id,
          upload_request_id: request.id,
          template: "renewal_request",
          to_email: contact.email,
          status: outboxStatus,
          provider_message_id: sendResult.providerMessageId,
          error: sendResult.error,
          sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
        })
        .select("id")
        .single();

      if (outboxError) throw new Error(outboxError.message);

      if (sendResult.status === "sent") anySent = true;

      outcomes.push({
        contactId: contact.id,
        vendorContactId: link.id,
        email: contact.email,
        role: link.role,
        outcome: sendResult.status,
        outboxId: outboxRow?.id ?? null,
      });
    }

    if (anySent) {
      await supabase
        .from("vendor_upload_requests")
        .update({ status: "email_sent" })
        .eq("id", request.id);
    }

    await supabase.from("audit_log").insert({
      company_id: vendorRow.company_id,
      action: "contact_request_sent",
      target_type: "vendor",
      target_id: vendorRow.id,
      detail: {
        requestId: request.id,
        purpose: data.purpose,
        recipients: outcomes.map((o) => ({ role: o.role, outcome: o.outcome })),
      },
    });

    return { requestId: request.id, uploadUrl, recipients: outcomes };
  });
