/**
 * Pure content builder for the renewal_reminder template - deliberately its
 * own wording, not a copy of renewalRequest* from src/workflows/emailTemplates.ts.
 * renewal_request is a person clicking "send" right now; this is an automated
 * nudge fired days/weeks ahead of an expiration the vendor may not be
 * thinking about yet, so it leads with the deadline instead of a generic
 * "please update your COI."
 */

export interface RenewalReminderEmailInput {
  vendorContactName: string;
  vendorName: string;
  companyName: string;
  uploadUrl: string;
  daysUntilExpiration: number;
  expirationDate: string;
  carrierName: string;
  policyNumber: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function urgencyPhrase(daysUntilExpiration: number): string {
  if (daysUntilExpiration <= 0) return "has expired";
  if (daysUntilExpiration === 1) return "expires tomorrow";
  return `expires in ${daysUntilExpiration} days`;
}

export function renewalReminderSubject(input: RenewalReminderEmailInput): string {
  return `Your general liability certificate ${urgencyPhrase(input.daysUntilExpiration)}`;
}

export function renewalReminderText(input: RenewalReminderEmailInput): string {
  const greeting = input.vendorContactName ? `Hi ${input.vendorContactName},` : "Hello,";
  return [
    greeting,
    "",
    `${input.companyName}'s records show ${input.vendorName}'s general liability certificate ` +
      `(${input.carrierName || "carrier on file"} #${input.policyNumber || "—"}) ` +
      `${urgencyPhrase(input.daysUntilExpiration)}, on ${input.expirationDate}.`,
    "",
    "To avoid a gap in your compliance status, please upload a renewed certificate:",
    input.uploadUrl,
    "",
    "This link is unique to you and does not require creating an account.",
    "If you've already renewed, uploading the new certificate will update this automatically.",
  ].join("\n");
}

export function renewalReminderHtml(input: RenewalReminderEmailInput): string {
  const greeting = input.vendorContactName
    ? `Hi ${escapeHtml(input.vendorContactName)},`
    : "Hello,";
  return `
    <div style="font-family:Arial,sans-serif;color:#0F172A;max-width:560px;">
      <p style="font-weight:700;">VendorClr</p>
      <p>${greeting}</p>
      <p>
        ${escapeHtml(input.companyName)}'s records show ${escapeHtml(input.vendorName)}'s general
        liability certificate (${escapeHtml(input.carrierName || "carrier on file")}
        #${escapeHtml(input.policyNumber || "—")})
        <strong>${escapeHtml(urgencyPhrase(input.daysUntilExpiration))}</strong>,
        on ${escapeHtml(input.expirationDate)}.
      </p>
      <p>To avoid a gap in your compliance status, please upload a renewed certificate:</p>
      <p style="margin-top:16px;">
        <a href="${escapeHtml(input.uploadUrl)}"
           style="background:#2563EB;color:#F8FAFC;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">
          Upload renewed certificate
        </a>
      </p>
      <p style="color:#475569;font-size:12px;">
        This link is unique to you and does not require creating an account. If you've already
        renewed, uploading the new certificate will update this automatically.
      </p>
    </div>
  `;
}
