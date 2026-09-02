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
