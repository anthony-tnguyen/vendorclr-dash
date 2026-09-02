import type { ComplianceStatus } from "@/data/contracts";
import type { ExtractedPolicy, PolicyType } from "./insuranceExtractionSchema";

/**
 * Turns an extracted policy into a decision about vendor_policies, and turns
 * an active policy into the four compliance-rail statuses extraction can
 * actually speak to. Pure, no I/O - the server wiring in
 * vendorUploadRequests.ts owns every database read/write; this module only
 * ever answers "given this data, what should happen."
 *
 * The central rule, stated in the very first review of this workflow and
 * carried through unchanged: never let an LLM's self-reported confidence gate
 * a database write. Confidence (Phase 2's overall_confidence) decides whether
 * an extraction is worth acting on *at all*; matchExtractedPolicy() below is
 * the separate, deterministic check that decides whether a specific update is
 * safe to apply automatically. A confident extraction that fails this check
 * still goes to review - confidence and safety are independent gates, and a
 * document must clear both.
 */

export interface ExistingPolicySnapshot {
  id: string;
  carrierName: string;
  policyNumber: string;
  expirationDate: string | null;
}

export type MatchOutcome =
  | { kind: "renew"; existingPolicyId: string }
  | { kind: "new_coverage" }
  | { kind: "needs_review"; reason: string };

/**
 * The one deterministic rule this phase auto-applies: carrier matches,
 * policy number matches, and the new expiration date is strictly later than
 * the one on file. Everything else - a new carrier, a changed policy number,
 * a date that didn't move forward, an unparseable date, or simply no
 * existing policy of this type to compare against - requires a human
 * decision. `new_coverage` (first time this vendor has any policy of this
 * type) is deliberately its own outcome, not folded into `needs_review`: it
 * is not an error, but it is not a renewal either, and a caller may
 * reasonably want to treat "first ever" more leniently than "no match"
 * later without touching this function.
 */
export function matchExtractedPolicy(
  extracted: ExtractedPolicy,
  existing: ExistingPolicySnapshot | null,
): MatchOutcome {
  if (!existing) return { kind: "new_coverage" };

  if (!extracted.carrier || !extracted.policy_number) {
    return { kind: "needs_review", reason: "Extraction is missing a carrier or policy number." };
  }
  if (extracted.carrier.trim().toLowerCase() !== existing.carrierName.trim().toLowerCase()) {
    return {
      kind: "needs_review",
      reason: `Carrier changed: "${existing.carrierName}" on file, "${extracted.carrier}" extracted.`,
    };
  }
  if (extracted.policy_number.trim() !== existing.policyNumber.trim()) {
    return {
      kind: "needs_review",
      reason: `Policy number changed: "${existing.policyNumber}" on file, "${extracted.policy_number}" extracted.`,
    };
  }

  const newExpiry = extracted.expiration_date ? new Date(extracted.expiration_date) : null;
  if (!newExpiry || Number.isNaN(newExpiry.getTime())) {
    return { kind: "needs_review", reason: "Extracted expiration date is missing or unparseable." };
  }

  const oldExpiry = existing.expirationDate ? new Date(existing.expirationDate) : null;
  if (
    oldExpiry &&
    !Number.isNaN(oldExpiry.getTime()) &&
    newExpiry.getTime() <= oldExpiry.getTime()
  ) {
    return {
      kind: "needs_review",
      reason: `New expiration ${extracted.expiration_date} is not later than the ${existing.expirationDate} on file.`,
    };
  }

  return { kind: "renew", existingPolicyId: existing.id };
}

export interface ComplianceInputs {
  /** True when this is the vendor's general-liability policy - see the module docblock in vendorUploadRequests.ts for why only GL drives the rail. */
  isPrimaryPolicy: boolean;
  expirationDate: string | null;
  additionalInsured: boolean | null;
  waiverOfSubrogation: boolean | null;
}

export interface ComplianceItemUpdate {
  status: ComplianceStatus;
  effectiveDate: string | null;
  note?: string | undefined;
}

const EXPIRING_WINDOW_DAYS = 30;

function dateStatus(
  expirationDate: string | null,
  now: Date,
): "missing" | "expired" | "expiring" | "compliant" {
  if (!expirationDate) return "missing";
  const expiry = new Date(expirationDate);
  if (Number.isNaN(expiry.getTime())) return "missing";

  const daysUntil = Math.floor((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  if (daysUntil < 0) return "expired";
  if (daysUntil <= EXPIRING_WINDOW_DAYS) return "expiring";
  return "compliant";
}

/**
 * Tri-state -> rail status. `null` means the extraction could not determine
 * this (see the extraction prompt's instruction not to guess additional-
 * insured/waiver status from a checkbox alone) - that is "missing", the same
 * as never having been provided, not a silent pass.
 */
function tristateStatus(value: boolean | null): ComplianceStatus {
  if (value === true) return "compliant";
  return "missing";
}

/**
 * Derives coi/additionalInsured/waiverOfSubrogation/renewal from one policy.
 * Deliberately does not touch lienWaiver - a lien waiver is a different
 * document type entirely, and a certificate of insurance has nothing to say
 * about it. Only called with the vendor's primary (general liability) policy
 * in practice; a non-GL renewal (workers comp, auto, umbrella) still updates
 * vendor_policies but does not move the rail, matching primaryPolicy()'s
 * GL-first logic in supabaseRepository.ts.
 */
export function computeComplianceItems(
  policy: ComplianceInputs,
  now: Date = new Date(),
): Record<"coi" | "additionalInsured" | "waiverOfSubrogation" | "renewal", ComplianceItemUpdate> {
  if (!policy.isPrimaryPolicy) {
    throw new Error(
      "computeComplianceItems() only makes sense for the vendor's primary (general liability) policy.",
    );
  }

  const status = dateStatus(policy.expirationDate, now);
  const dateNote =
    status === "expired"
      ? "Certificate lapsed"
      : status === "expiring"
        ? `Expires within ${EXPIRING_WINDOW_DAYS} days`
        : undefined;

  return {
    coi: { status, effectiveDate: policy.expirationDate, note: dateNote },
    renewal: { status, effectiveDate: policy.expirationDate, note: dateNote },
    additionalInsured: {
      status: tristateStatus(policy.additionalInsured),
      effectiveDate: policy.additionalInsured === true ? policy.expirationDate : null,
      note: policy.additionalInsured === null ? "Not confirmed by the certificate" : undefined,
    },
    waiverOfSubrogation: {
      status: tristateStatus(policy.waiverOfSubrogation),
      effectiveDate: policy.waiverOfSubrogation === true ? policy.expirationDate : null,
      note: policy.waiverOfSubrogation === null ? "Not confirmed by the certificate" : undefined,
    },
  };
}

/**
 * True if any policy in an extraction has a coverage type the model could
 * not classify (normalizePolicyType() returned null but the row exists) - a
 * document that reports finding a policy it couldn't name is exactly the
 * kind of gap a real coverage requirement could hide behind, so the whole
 * document is routed to review even if every other policy matched cleanly.
 */
export function hasUnclassifiedPolicy(policies: ExtractedPolicy[]): boolean {
  return policies.some((p) => p.type === null);
}

export function isGeneralLiability(type: PolicyType | null): boolean {
  return type === "general_liability";
}
