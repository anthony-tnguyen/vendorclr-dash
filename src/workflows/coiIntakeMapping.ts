import type { VendorTrade } from "@/data/contracts";

import { type InsuranceExtraction, type PolicyType } from "./insuranceExtractionSchema";

/**
 * Pure mapping from a certificate-of-insurance extraction to a proposed vendor
 * and its policy lines. No I/O and no server imports, so the mapping (the part
 * most worth testing) is unit-testable without an API key or a database, the
 * same discipline insuranceExtractionSchema.ts already follows.
 *
 * A COI (ACORD 25) does not carry the vendor's trade, so `trade` is never
 * proposed here — it is the one field the customer must supply on the review
 * screen before a vendor can be created. Everything else is filled from the
 * certificate.
 */

/** The trades a vendor may carry — mirrors VendorTrade / vendors.trade CHECK. */
export const VENDOR_TRADES: VendorTrade[] = [
  "Structural Steel",
  "Electrical",
  "Mechanical / HVAC",
  "Concrete",
  "Earthwork",
  "Roofing",
  "Glazing",
  "Fire Protection",
];

export function isVendorTrade(value: string): value is VendorTrade {
  return (VENDOR_TRADES as string[]).includes(value);
}

export const POLICY_TYPE_LABELS: Record<PolicyType, string> = {
  general_liability: "General Liability",
  workers_compensation: "Workers' Compensation",
  commercial_auto: "Auto Liability",
  umbrella: "Umbrella / Excess",
  professional_liability: "Professional Liability",
  pollution_liability: "Pollution Liability",
  builders_risk: "Builder's Risk",
};

/**
 * Below this overall confidence the extraction is flagged for review rather than
 * trusted outright. Kept in step with documentExtraction.ts's own
 * needs-review threshold, but defined here so this pure module carries no
 * server-only import.
 */
export const COI_NEEDS_REVIEW_BELOW = 0.8;

export interface ProposedPolicy {
  policyType: PolicyType;
  carrier: string;
  policyNumber: string;
  /** ISO date (yyyy-mm-dd) or null. */
  effectiveDate: string | null;
  expirationDate: string | null;
  eachOccurrenceLimit: number | null;
  generalAggregateLimit: number | null;
  additionalInsured: boolean | null;
  waiverOfSubrogation: boolean | null;
  primaryNoncontributory: boolean | null;
}

export interface CoiVendorProposal {
  /** From the certificate's insured — the customer confirms/edits it. */
  vendorName: string;
  policies: ProposedPolicy[];
  overallConfidence: number;
  /** True when the extraction's confidence is below the review threshold. */
  needsReview: boolean;
  notes: string | null;
  /** Policy lines the model could not classify (null type), dropped from `policies`. */
  unclassifiedPolicies: number;
}

/** Turn a validated extraction into a vendor proposal the review screen renders. */
export function proposalFromExtraction(extraction: InsuranceExtraction): CoiVendorProposal {
  const policies: ProposedPolicy[] = [];
  let unclassified = 0;

  for (const policy of extraction.policies) {
    if (!policy.type) {
      unclassified += 1;
      continue;
    }
    policies.push({
      policyType: policy.type,
      carrier: policy.carrier ?? "",
      policyNumber: policy.policy_number ?? "",
      effectiveDate: policy.effective_date,
      expirationDate: policy.expiration_date,
      eachOccurrenceLimit: policy.limits?.each_occurrence ?? null,
      generalAggregateLimit: policy.limits?.general_aggregate ?? null,
      additionalInsured: policy.additional_insured,
      waiverOfSubrogation: policy.waiver_of_subrogation,
      primaryNoncontributory: policy.primary_noncontributory ?? null,
    });
  }

  return {
    vendorName: (extraction.insured?.name ?? "").trim(),
    policies,
    overallConfidence: extraction.overall_confidence,
    needsReview: extraction.overall_confidence < COI_NEEDS_REVIEW_BELOW,
    notes: extraction.notes,
    unclassifiedPolicies: unclassified,
  };
}
