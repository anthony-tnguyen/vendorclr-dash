import { describe, expect, it } from "vitest";

import { proposalFromExtraction, COI_NEEDS_REVIEW_BELOW } from "@/workflows/coiIntakeMapping";
import type { InsuranceExtraction } from "@/workflows/insuranceExtractionSchema";

function extraction(overrides: Partial<InsuranceExtraction> = {}): InsuranceExtraction {
  return {
    document_type: "ACORD_25",
    insured: { name: "  Rivera Electrical Contractors  ", address: null },
    producer: { name: null },
    certificate_holder: { name: null, address: null },
    overall_confidence: 0.95,
    notes: null,
    policies: [],
    ...overrides,
  } as InsuranceExtraction;
}

function policy(over: Record<string, unknown> = {}) {
  return {
    type: "general_liability",
    carrier: "Acme Mutual",
    policy_number: "GL-123",
    effective_date: "2026-01-01",
    expiration_date: "2027-01-01",
    limits: { each_occurrence: 1000000, general_aggregate: 2000000 },
    additional_insured: true,
    waiver_of_subrogation: null,
    primary_noncontributory: null,
    employers_liability: null,
    follows_form: null,
    endorsement_forms: null,
    additional_insured_ongoing_operations: null,
    additional_insured_completed_operations: null,
    cancellation_notice_provided: null,
    cancellation_notice_days: null,
    ...over,
  };
}

describe("proposalFromExtraction", () => {
  it("trims the insured name into the proposed vendor name", () => {
    const proposal = proposalFromExtraction(extraction());
    expect(proposal.vendorName).toBe("Rivera Electrical Contractors");
  });

  it("maps a classified policy line into a proposed policy", () => {
    const proposal = proposalFromExtraction(extraction({ policies: [policy()] as never }));
    expect(proposal.policies).toHaveLength(1);
    expect(proposal.policies[0]).toMatchObject({
      policyType: "general_liability",
      carrier: "Acme Mutual",
      policyNumber: "GL-123",
      effectiveDate: "2026-01-01",
      expirationDate: "2027-01-01",
      eachOccurrenceLimit: 1000000,
      generalAggregateLimit: 2000000,
      additionalInsured: true,
    });
  });

  it("drops and counts policy lines the model could not classify", () => {
    const proposal = proposalFromExtraction(
      extraction({ policies: [policy(), policy({ type: null })] as never }),
    );
    expect(proposal.policies).toHaveLength(1);
    expect(proposal.unclassifiedPolicies).toBe(1);
  });

  it("flags low-confidence extractions for review", () => {
    const low = proposalFromExtraction(extraction({ overall_confidence: 0.4 }));
    expect(low.needsReview).toBe(true);
    const high = proposalFromExtraction(
      extraction({ overall_confidence: COI_NEEDS_REVIEW_BELOW + 0.05 }),
    );
    expect(high.needsReview).toBe(false);
  });

  it("defaults missing carrier/number to empty strings and missing limits to null", () => {
    const proposal = proposalFromExtraction(
      extraction({
        policies: [policy({ carrier: null, policy_number: null, limits: {} })] as never,
      }),
    );
    const first = proposal.policies[0]!;
    expect(first.carrier).toBe("");
    expect(first.policyNumber).toBe("");
    expect(first.eachOccurrenceLimit).toBeNull();
    expect(first.generalAggregateLimit).toBeNull();
  });
});
