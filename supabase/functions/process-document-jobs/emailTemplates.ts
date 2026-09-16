// Byte-for-byte port of the documentReceived*/adminReviewNeeded* half of
// src/workflows/emailTemplates.ts - pure string builders, no I/O, ported the
// same way send-renewal-reminders/emailTemplates.ts already ports its own
// slice of that file (renewalReminder*). Only what applyExtractionResult()'s
// notifyDocumentOutcome() needs; the rest of the Node file (renewalRequest*,
// companyInvitation*, etc.) has no caller here. If the Node original
// changes, check this file too.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// documentReceived - sent to the vendor right after their upload finishes
// processing.
// ---------------------------------------------------------------------------

export type DocumentOutcome = "processed" | "needs_review" | "failed";

export interface DocumentReceivedEmailInput {
  vendorContactName: string;
  vendorName: string;
  companyName: string;
  outcome: DocumentOutcome;
}

function documentOutcomeCopy(outcome: DocumentOutcome): { subject: string; body: string } {
  switch (outcome) {
    case "processed":
      return {
        subject: "We received your updated certificate",
        body: "Thanks for sending that over. We received your certificate and everything looks current - no further action is needed right now.",
      };
    case "needs_review":
      return {
        subject: "We received your updated certificate",
        body: "Thanks for sending that over. We received your certificate and are taking a closer look before it's finalized. We'll follow up if we need anything else from you.",
      };
    case "failed":
      return {
        subject: "We received your file",
        body: "Thanks for sending that over. We received your file but ran into an issue processing it automatically. Our team will follow up shortly.",
      };
  }
}

export function documentReceivedSubject(input: DocumentReceivedEmailInput): string {
  return documentOutcomeCopy(input.outcome).subject;
}

export function documentReceivedText(input: DocumentReceivedEmailInput): string {
  const greeting = input.vendorContactName ? `Hi ${input.vendorContactName},` : "Hello,";
  return [greeting, "", documentOutcomeCopy(input.outcome).body, "", `- ${input.companyName}`].join(
    "\n",
  );
}

export function documentReceivedHtml(input: DocumentReceivedEmailInput): string {
  const greeting = input.vendorContactName
    ? `Hi ${escapeHtml(input.vendorContactName)},`
    : "Hello,";
  return `
    <div style="font-family:Arial,sans-serif;color:#0F172A;max-width:560px;">
      <p style="font-weight:700;">VendorClr</p>
      <p>${greeting}</p>
      <p>${escapeHtml(documentOutcomeCopy(input.outcome).body)}</p>
      <p style="color:#475569;font-size:12px;">- ${escapeHtml(input.companyName)}</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// adminReviewNeeded - sent to the company's owner(s) when a document needs a
// human decision.
// ---------------------------------------------------------------------------

export interface AdminReviewNeededEmailInput {
  vendorName: string;
  documentFileName: string;
  outcome: "needs_review" | "failed";
  reason: string | null;
}

export function adminReviewNeededSubject(input: AdminReviewNeededEmailInput): string {
  return `Action needed: ${input.vendorName}'s certificate needs review`;
}

export function adminReviewNeededText(input: AdminReviewNeededEmailInput): string {
  const reasonLine = input.reason
    ? `Reason: ${input.reason}`
    : "No specific reason was recorded - check the Compliance Queue for details.";
  return [
    `${input.vendorName} uploaded "${input.documentFileName}", but it could not be applied automatically.`,
    "",
    reasonLine,
    "",
    "Review it in the Compliance Queue.",
  ].join("\n");
}

export function adminReviewNeededHtml(input: AdminReviewNeededEmailInput): string {
  const reasonLine = input.reason
    ? escapeHtml(input.reason)
    : "No specific reason was recorded - check the Compliance Queue for details.";
  return `
    <div style="font-family:Arial,sans-serif;color:#0F172A;max-width:560px;">
      <p style="font-weight:700;">VendorClr</p>
      <p>
        ${escapeHtml(input.vendorName)} uploaded "${escapeHtml(input.documentFileName)}",
        but it could not be applied automatically.
      </p>
      <p style="background:#FEF3C7;border-radius:6px;padding:10px 12px;">${reasonLine}</p>
      <p>Review it in the Compliance Queue.</p>
    </div>
  `;
}
