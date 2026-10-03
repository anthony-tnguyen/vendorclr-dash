// Byte-for-byte port of src/workflows/complianceEngine.ts's pure functions
// (matchExtractedPolicy, computeComplianceItems, hasUnclassifiedPolicy,
// isGeneralLiability) to Supabase's Deno Edge Runtime - no I/O, no
// Deno-specific APIs, nothing here differs from the Node original except the
// two type imports, which point at this directory's own copies
// (the generated canonical parser contract) and a local ComplianceStatus type (below)
// instead of "@/data/contracts", which is not resolvable across the Node/
// Deno boundary. If the Node original changes, check this file too.
//
// Ported deliberately, not shortcut to "always needs_review" the way
// retry-failed-documents/index.ts's re-extraction path is: this Edge
// Function processes FIRST-TIME extractions for freshly-submitted
// documents, the same jobs that today - before this worker existed - ran
// synchronously in uploadDocumentForTokenHandler()/applyExtractionResult()
// and auto-applied a clean match to vendor_policies with no human review at
// all. Taking retry-failed-documents' shortcut here would silently turn
// every submission into a human-review item, a real regression of this
// app's Phase 3 feature, not a neutral simplification - see this Edge
// Function's own index.ts docblock and this dispatch's task description for
// the full reasoning.
import type { ExtractedPolicy, PolicyType } from "../_shared/coiParserContract.ts";

export type ComplianceStatus = "compliant" | "expiring" | "missing" | "expired" | "pending";

export interface ExistingPolicySnapshot {
  id: string;
  carrierName: string;
  policyNumber: string;
  expirationDate: string | null;
}

export interface RequirementSnapshot {
  label: string;
  limitField: "each_occurrence" | "general_aggregate";
  requiredAmount: number;
}

export type MatchOutcome =
  | { kind: "renew"; existingPolicyId: string }
  | { kind: "new_coverage" }
  | { kind: "needs_review"; reason: string };

export function matchExtractedPolicy(
  extracted: ExtractedPolicy,
  existing: ExistingPolicySnapshot | null,
  requirements: RequirementSnapshot[] = [],
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

  for (const req of requirements) {
    const carried = extracted.limits[req.limitField];
    if (carried === null || carried === undefined || carried < req.requiredAmount) {
      const shown =
        carried === null || carried === undefined ? "no amount" : `$${carried.toLocaleString()}`;
      return {
        kind: "needs_review",
        reason: `${req.label} requires at least $${req.requiredAmount.toLocaleString()}, certificate shows ${shown}.`,
      };
    }
  }

  return { kind: "renew", existingPolicyId: existing.id };
}

export interface ComplianceInputs {
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

function tristateStatus(value: boolean | null): ComplianceStatus {
  if (value === true) return "compliant";
  return "missing";
}

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

export function hasUnclassifiedPolicy(policies: ExtractedPolicy[]): boolean {
  return policies.some((p) => p.type === null);
}

export function isGeneralLiability(type: PolicyType | null): boolean {
  return type === "general_liability";
}
