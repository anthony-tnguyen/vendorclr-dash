// @ts-nocheck - runs in Supabase's Deno Edge Runtime, not the app's Node/
// TypeScript project (see index.ts's own header comment for why).
//
// Pure content builders for the two internal (owner/risk_manager) email
// notifications compliance-housekeeping sends - deliberately its own
// wording, not a copy of adminReviewNeeded* from src/workflows/emailTemplates.ts
// (that one is about a document extraction needing a human decision; these
// are about a deficiency correction going unanswered past a threshold, or
// an approved exception expiring and reopening a deficiency). Same
// escapeHtml() shape as every other Edge Function's local emailTemplates.ts
// (send-renewal-reminders, process-document-jobs) - duplicated rather than
// imported across the Node/Deno boundary, same established convention; if
// one copy of escapeHtml() changes, the others do not automatically.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// deficiencyEscalated - sent when an open deficiency's correction request
// crosses the 3/7/14-day threshold with no resolving re-evaluation yet.
// ---------------------------------------------------------------------------

export interface DeficiencyEscalatedEmailInput {
  vendorName: string;
  requirementKey: string;
  explanation: string;
  nextLevel: number;
  daysSinceRequested: number;
}

const LEVEL_LABEL: Record<number, string> = {
  1: "3-day",
  2: "7-day",
  3: "14-day",
};

export function deficiencyEscalatedSubject(input: DeficiencyEscalatedEmailInput): string {
  return `Unanswered correction request: ${input.vendorName} (${LEVEL_LABEL[input.nextLevel] ?? `level ${input.nextLevel}`})`;
}

export function deficiencyEscalatedText(input: DeficiencyEscalatedEmailInput): string {
  return [
    `${input.vendorName}'s correction request for "${input.requirementKey}" has gone unanswered for ${input.daysSinceRequested} days - this is the ${LEVEL_LABEL[input.nextLevel] ?? `level ${input.nextLevel}`} escalation.`,
    "",
    `Reason on file: ${input.explanation}`,
    "",
    "Review this deficiency and follow up with the vendor in the Compliance Queue.",
  ].join("\n");
}

export function deficiencyEscalatedHtml(input: DeficiencyEscalatedEmailInput): string {
  return `
    <div style="font-family:Arial,sans-serif;color:#0F172A;max-width:560px;">
      <p style="font-weight:700;">VendorClr</p>
      <p>
        ${escapeHtml(input.vendorName)}'s correction request for "${escapeHtml(input.requirementKey)}"
        has gone unanswered for ${input.daysSinceRequested} days - this is the
        <strong>${escapeHtml(LEVEL_LABEL[input.nextLevel] ?? `level ${input.nextLevel}`)}</strong> escalation.
      </p>
      <p>Reason on file: ${escapeHtml(input.explanation)}</p>
      <p>Review this deficiency and follow up with the vendor in the Compliance Queue.</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// exceptionExpiredReopened - sent when an approved exception's expires_on
// has passed and the waived deficiency has just been reopened.
// ---------------------------------------------------------------------------

export interface ExceptionExpiredReopenedEmailInput {
  vendorName: string;
  requirementKey: string;
  explanation: string;
  exceptionReason: string;
  expiresOn: string;
}

export function exceptionExpiredReopenedSubject(input: ExceptionExpiredReopenedEmailInput): string {
  return `Exception expired, deficiency reopened: ${input.vendorName}`;
}

export function exceptionExpiredReopenedText(input: ExceptionExpiredReopenedEmailInput): string {
  return [
    `The approved exception for ${input.vendorName}'s "${input.requirementKey}" deficiency expired on ${input.expiresOn} and has not been renewed.`,
    "",
    `Original exception reason: ${input.exceptionReason}`,
    `Deficiency: ${input.explanation}`,
    "",
    "This deficiency is now open again and needs a follow-up decision - a fresh correction request, a new exception, or another look at the vendor's coverage.",
  ].join("\n");
}

export function exceptionExpiredReopenedHtml(input: ExceptionExpiredReopenedEmailInput): string {
  return `
    <div style="font-family:Arial,sans-serif;color:#0F172A;max-width:560px;">
      <p style="font-weight:700;">VendorClr</p>
      <p>
        The approved exception for ${escapeHtml(input.vendorName)}'s "${escapeHtml(input.requirementKey)}"
        deficiency <strong>expired on ${escapeHtml(input.expiresOn)}</strong> and has not been renewed.
      </p>
      <p>Original exception reason: ${escapeHtml(input.exceptionReason)}</p>
      <p>Deficiency: ${escapeHtml(input.explanation)}</p>
      <p>
        This deficiency is now open again and needs a follow-up decision - a fresh correction
        request, a new exception, or another look at the vendor's coverage.
      </p>
    </div>
  `;
}
