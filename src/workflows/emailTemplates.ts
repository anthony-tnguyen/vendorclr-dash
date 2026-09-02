/**
 * Pure email content builders. No I/O, no server-function context - kept
 * separate so subject/body wording can be unit-tested and reviewed without a
 * database or a provider.
 */

export interface RenewalRequestEmailInput {
  vendorContactName: string;
  vendorName: string;
  companyName: string;
  uploadUrl: string;
  currentPolicies: Array<{
    policyType: string;
    carrierName: string;
    policyNumber: string;
    expirationDate: string | null;
  }>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPolicyTypeLabel(policyType: string): string {
  return policyType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function renewalRequestSubject(input: RenewalRequestEmailInput): string {
  return `${input.companyName} needs your updated certificate of insurance`;
}

export function renewalRequestText(input: RenewalRequestEmailInput): string {
  const greeting = input.vendorContactName ? `Hi ${input.vendorContactName},` : "Hello,";
  const policyLines =
    input.currentPolicies.length > 0
      ? input.currentPolicies
          .map(
            (p) =>
              `- ${formatPolicyTypeLabel(p.policyType)}: ${p.carrierName || "Carrier on file"} #${p.policyNumber || "—"}, expires ${p.expirationDate ?? "unknown"}`,
          )
          .join("\n")
      : "- No policy currently on file";

  return [
    greeting,
    "",
    `${input.companyName} uses VendorClear to keep vendor insurance records current, and needs an updated certificate of insurance from ${input.vendorName}.`,
    "",
    "Here's what we currently have on file:",
    policyLines,
    "",
    `Upload your renewed certificate: ${input.uploadUrl}`,
    "",
    "This link is unique to you and does not require creating an account.",
  ].join("\n");
}

export function renewalRequestHtml(input: RenewalRequestEmailInput): string {
  const greeting = input.vendorContactName
    ? `Hi ${escapeHtml(input.vendorContactName)},`
    : "Hello,";

  const rows =
    input.currentPolicies.length > 0
      ? input.currentPolicies
          .map(
            (p) => `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(formatPolicyTypeLabel(p.policyType))}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(p.carrierName || "—")}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(p.policyNumber || "—")}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(p.expirationDate ?? "—")}</td>
        </tr>`,
          )
          .join("")
      : `<tr><td colspan="4" style="padding:6px 12px;">No policy currently on file</td></tr>`;

  return `
    <div style="font-family:Arial,sans-serif;color:#0F172A;max-width:560px;">
      <p style="font-weight:700;">VendorClear</p>
      <p>${greeting}</p>
      <p>
        ${escapeHtml(input.companyName)} uses VendorClear to keep vendor insurance records
        current, and needs an updated certificate of insurance from
        ${escapeHtml(input.vendorName)}.
      </p>
      <p>Here's what we currently have on file:</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="text-align:left;">
            <th style="padding:6px 12px;border-bottom:2px solid #0F172A;">Coverage</th>
            <th style="padding:6px 12px;border-bottom:2px solid #0F172A;">Carrier</th>
            <th style="padding:6px 12px;border-bottom:2px solid #0F172A;">Policy</th>
            <th style="padding:6px 12px;border-bottom:2px solid #0F172A;">Expires</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:24px;">
        <a href="${escapeHtml(input.uploadUrl)}"
           style="background:#2563EB;color:#F8FAFC;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">
          Upload updated insurance
        </a>
      </p>
      <p style="color:#475569;font-size:12px;">
        This link is unique to you and does not require creating an account.
      </p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// documentReceived - sent to the vendor right after their upload finishes
// processing (src/workflows/vendorUploadRequests.ts, applyExtractionResult()).
// ---------------------------------------------------------------------------

export type DocumentOutcome = "processed" | "needs_review" | "failed";

export interface DocumentReceivedEmailInput {
  vendorContactName: string;
  vendorName: string;
  companyName: string;
  outcome: DocumentOutcome;
}

/**
 * Deliberately generic for needs_review/failed - never repeats the specific
 * matching-engine reason (a changed carrier, an unparseable date) back to the
 * vendor. That detail is for adminReviewNeeded*() below, where it helps a
 * reviewer act; to a vendor it would read as unexplained internal jargon, or
 * worse, invite them to argue with an automated decision rather than wait for
 * a person to look at it.
 */
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
      <p style="font-weight:700;">VendorClear</p>
      <p>${greeting}</p>
      <p>${escapeHtml(documentOutcomeCopy(input.outcome).body)}</p>
      <p style="color:#475569;font-size:12px;">- ${escapeHtml(input.companyName)}</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// adminReviewNeeded - sent to the company's owner(s) when a document needs a
// human decision. Unlike documentReceived, this carries the specific reason -
// the person reading it is the one who has to act on it.
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
      <p style="font-weight:700;">VendorClear</p>
      <p>
        ${escapeHtml(input.vendorName)} uploaded "${escapeHtml(input.documentFileName)}",
        but it could not be applied automatically.
      </p>
      <p style="background:#FEF3C7;border-radius:6px;padding:10px 12px;">${reasonLine}</p>
      <p>Review it in the Compliance Queue.</p>
    </div>
  `;
}
