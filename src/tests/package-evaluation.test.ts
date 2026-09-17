import { describe, expect, it } from "vitest";

import {
  evaluateRequirementsAgainstEvidence,
  namesLooselyMatch,
  type CertificateHolderOnFile,
  type PackageEvidence,
  type PackageEvidenceDocument,
} from "@/domain/compliance/evaluatePackage";
import type { ResolvedRequirement } from "@/domain/construction/types";
import type { ExtractedPolicy, InsuranceExtraction } from "@/workflows/insuranceExtractionSchema";

/**
 * Task 9b - unit tests for the pure core of the package evaluator. Mirrors
 * src/tests/compliance-engine.test.ts's fixture-builder style
 * (policy()/existing() there, requirement()/policy()/extraction()/doc()
 * here).
 */

function requirement(overrides: Partial<ResolvedRequirement> = {}): ResolvedRequirement {
  return {
    key: "gl_each_occ",
    policyType: "general_liability",
    kind: "limit",
    required: true,
    amount: 1_000_000,
    source: "company_profile",
    configuration: { limitField: "each_occurrence" },
    ...overrides,
  };
}

function policy(overrides: Partial<ExtractedPolicy> = {}): ExtractedPolicy {
  return {
    type: "general_liability",
    carrier: "Travelers",
    policy_number: "GL-8841-2266",
    effective_date: "2026-11-30",
    expiration_date: "2027-11-30",
    limits: {},
    additional_insured: null,
    waiver_of_subrogation: null,
    primary_noncontributory: null,
    additional_insured_ongoing_operations: null,
    additional_insured_completed_operations: null,
    cancellation_notice_provided: null,
    cancellation_notice_days: null,
    employers_liability: null,
    follows_form: null,
    endorsement_forms: null,
    ...overrides,
  };
}

function extraction(overrides: Partial<InsuranceExtraction> = {}): InsuranceExtraction {
  return {
    document_type: "ACORD_25",
    insured: { name: "Corbett Steel", address: null },
    producer: { name: null },
    policies: [policy()],
    certificate_holder: { name: null, address: null },
    overall_confidence: 0.9,
    notes: null,
    ...overrides,
  };
}

function doc(overrides: Partial<PackageEvidenceDocument> = {}): PackageEvidenceDocument {
  return {
    id: "doc-1",
    documentKind: "certificate_of_insurance",
    processingStatus: "processed",
    parsedData: extraction(),
    ...overrides,
  };
}

function evidence(documents: PackageEvidenceDocument[]): PackageEvidence {
  return { documents };
}

const NO_CERTIFICATE_HOLDER: CertificateHolderOnFile = { name: "", address: "" };
const CERTIFICATE_HOLDER: CertificateHolderOnFile = {
  name: "Halstead Builders",
  address: "100 Main St",
};

function find(
  requirements: ResolvedRequirement[],
  ev: PackageEvidence,
  ch: CertificateHolderOnFile = NO_CERTIFICATE_HOLDER,
) {
  const findings = evaluateRequirementsAgainstEvidence(requirements, ev, ch);
  return findings[0]!;
}

describe("evaluateRequirementsAgainstEvidence() - limit", () => {
  it("verifies when the best matching limit meets the required amount", () => {
    const req = requirement({ amount: 1_000_000 });
    const ev = evidence([
      doc({
        parsedData: extraction({ policies: [policy({ limits: { each_occurrence: 2_000_000 } })] }),
      }),
    ]);
    const result = find([req], ev);
    expect(result.state).toBe("verified");
    expect(result.observed).toEqual({ amount: 2_000_000 });
    expect(result.evidenceDocumentIds).toEqual(["doc-1"]);
  });

  it("is deficient when the best matching limit is below the required amount", () => {
    const req = requirement({ amount: 2_000_000 });
    const ev = evidence([
      doc({
        parsedData: extraction({ policies: [policy({ limits: { each_occurrence: 1_000_000 } })] }),
      }),
    ]);
    const result = find([req], ev);
    expect(result.state).toBe("deficient");
    expect(result.observed).toEqual({ amount: 1_000_000 });
  });

  it("is deficient when no policy of the required type is found anywhere in the package", () => {
    const req = requirement({ policyType: "general_liability" });
    const ev = evidence([
      doc({ parsedData: extraction({ policies: [policy({ type: "workers_compensation" })] }) }),
    ]);
    const result = find([req], ev);
    expect(result.state).toBe("deficient");
    expect(result.observed).toBeNull();
    expect(result.evidenceDocumentIds).toEqual([]);
  });

  it("is unknown (never verified) when a matching policy line exists but the specific limit field is null - a null limit must never be silently treated as passing", () => {
    const req = requirement({ amount: 1_000_000 });
    const ev = evidence([
      doc({
        parsedData: extraction({
          policies: [policy({ limits: { each_occurrence: null, general_aggregate: 5_000_000 } })],
        }),
      }),
    ]);
    const result = find([req], ev);
    expect(result.state).toBe("unknown");
    expect(result.observed).toBeNull();
    expect(result.state).not.toBe("verified");
  });

  it("aggregates the best value across multiple documents in the same package and records every contributing document id", () => {
    const req = requirement({ amount: 1_500_000 });
    const ev = evidence([
      doc({
        id: "doc-low",
        parsedData: extraction({ policies: [policy({ limits: { each_occurrence: 1_000_000 } })] }),
      }),
      doc({
        id: "doc-high",
        parsedData: extraction({ policies: [policy({ limits: { each_occurrence: 3_000_000 } })] }),
      }),
    ]);
    const result = find([req], ev);
    expect(result.state).toBe("verified");
    expect(result.observed).toEqual({ amount: 3_000_000 });
    expect(result.evidenceDocumentIds.sort()).toEqual(["doc-high", "doc-low"]);
  });
});

describe("evaluateRequirementsAgainstEvidence() - endorsement", () => {
  const endorsementReq = requirement({
    key: "gl_ai",
    kind: "endorsement",
    amount: null,
    configuration: { endorsementField: "additional_insured" },
  });

  it("verifies when at least one matching policy line has the field true", () => {
    const ev = evidence([
      doc({ parsedData: extraction({ policies: [policy({ additional_insured: true })] }) }),
    ]);
    const result = find([endorsementReq], ev);
    expect(result.state).toBe("verified");
  });

  it("is deficient when every matching policy line has the field explicitly false", () => {
    const ev = evidence([
      doc({ parsedData: extraction({ policies: [policy({ additional_insured: false })] }) }),
    ]);
    const result = find([endorsementReq], ev);
    expect(result.state).toBe("deficient");
  });

  it("a null additional_insured field never produces verified - it produces unknown", () => {
    const ev = evidence([
      doc({ parsedData: extraction({ policies: [policy({ additional_insured: null })] }) }),
    ]);
    const result = find([endorsementReq], ev);
    expect(result.state).toBe("unknown");
    expect(result.state).not.toBe("verified");
  });

  it("is unknown when no matching policy line exists at all (absent, not just null)", () => {
    const ev = evidence([
      doc({ parsedData: extraction({ policies: [policy({ type: "commercial_auto" })] }) }),
    ]);
    const result = find([endorsementReq], ev);
    expect(result.state).toBe("unknown");
  });

  it("true on any of several matching lines wins as verified, even if others are false or null", () => {
    const ev = evidence([
      doc({
        id: "doc-false",
        parsedData: extraction({ policies: [policy({ additional_insured: false })] }),
      }),
      doc({
        id: "doc-null",
        parsedData: extraction({ policies: [policy({ additional_insured: null })] }),
      }),
      doc({
        id: "doc-true",
        parsedData: extraction({ policies: [policy({ additional_insured: true })] }),
      }),
    ]);
    const result = find([endorsementReq], ev);
    expect(result.state).toBe("verified");
    expect(result.evidenceDocumentIds).toEqual(["doc-true"]);
  });
});

describe("evaluateRequirementsAgainstEvidence() - document", () => {
  const documentReq = requirement({
    key: "coi_present",
    kind: "document",
    policyType: null,
    amount: null,
    configuration: { documentKind: "certificate_of_insurance" },
  });

  it("verifies when a processed document of the required kind is present", () => {
    const ev = evidence([
      doc({ documentKind: "certificate_of_insurance", processingStatus: "processed" }),
    ]);
    const result = find([documentReq], ev);
    expect(result.state).toBe("verified");
    expect(result.evidenceDocumentIds).toEqual(["doc-1"]);
  });

  it("verifies when the document is present with needs_review status", () => {
    const ev = evidence([
      doc({ documentKind: "certificate_of_insurance", processingStatus: "needs_review" }),
    ]);
    const result = find([documentReq], ev);
    expect(result.state).toBe("verified");
  });

  it("does not count a failed-processing document as evidence", () => {
    const ev = evidence([
      doc({ documentKind: "certificate_of_insurance", processingStatus: "failed" }),
    ]);
    const result = find([documentReq], ev);
    expect(result.state).toBe("deficient");
  });

  it("is deficient when no document of the required kind is present at all", () => {
    const ev = evidence([doc({ documentKind: "other" })]);
    const result = find([documentReq], ev);
    expect(result.state).toBe("deficient");
    expect(result.observed).toBeNull();
  });
});

describe("evaluateRequirementsAgainstEvidence() - certificate_holder", () => {
  const chReq = requirement({
    key: "ch_on_file",
    kind: "certificate_holder",
    policyType: null,
    amount: null,
    configuration: {},
  });

  it("verifies when a document's captured certificate holder matches the project's on file", () => {
    const ev = evidence([
      doc({
        parsedData: extraction({
          certificate_holder: { name: "Halstead Builders", address: "100 Main St" },
        }),
      }),
    ]);
    const result = find([chReq], ev, CERTIFICATE_HOLDER);
    expect(result.state).toBe("verified");
  });

  it("is deficient when every present comparison is a mismatch", () => {
    const ev = evidence([
      doc({
        parsedData: extraction({ certificate_holder: { name: "Some Other GC", address: null } }),
      }),
    ]);
    const result = find([chReq], ev, CERTIFICATE_HOLDER);
    expect(result.state).toBe("deficient");
  });

  it("is unknown when the project has no certificate holder on file", () => {
    const ev = evidence([
      doc({
        parsedData: extraction({
          certificate_holder: { name: "Halstead Builders", address: null },
        }),
      }),
    ]);
    const result = find([chReq], ev, NO_CERTIFICATE_HOLDER);
    expect(result.state).toBe("unknown");
  });

  it("is unknown when no document captured a certificate holder name", () => {
    const ev = evidence([
      doc({ parsedData: extraction({ certificate_holder: { name: null, address: null } }) }),
    ]);
    const result = find([chReq], ev, CERTIFICATE_HOLDER);
    expect(result.state).toBe("unknown");
  });
});

describe("namesLooselyMatch()", () => {
  it("matches after trimming and case-folding", () => {
    expect(namesLooselyMatch("  Halstead Builders ", "halstead builders")).toBe(true);
  });

  it("does not match genuinely different names", () => {
    expect(namesLooselyMatch("Halstead Builders", "Acme GC")).toBe(false);
  });
});

describe("evaluateRequirementsAgainstEvidence() - determinism", () => {
  it("returns deep-equal results for identical inputs across two calls", () => {
    const requirements = [
      requirement({ key: "gl_each_occ", kind: "limit", amount: 1_000_000 }),
      requirement({
        key: "gl_ai",
        kind: "endorsement",
        amount: null,
        configuration: { endorsementField: "additional_insured" },
      }),
      requirement({
        key: "coi_present",
        kind: "document",
        policyType: null,
        amount: null,
        configuration: { documentKind: "certificate_of_insurance" },
      }),
      requirement({
        key: "ch_on_file",
        kind: "certificate_holder",
        policyType: null,
        amount: null,
        configuration: {},
      }),
    ];
    const ev = evidence([
      doc({
        parsedData: extraction({
          policies: [policy({ limits: { each_occurrence: 2_000_000 }, additional_insured: true })],
          certificate_holder: { name: "Halstead Builders", address: "100 Main St" },
        }),
      }),
    ]);

    const first = evaluateRequirementsAgainstEvidence(requirements, ev, CERTIFICATE_HOLDER);
    const second = evaluateRequirementsAgainstEvidence(requirements, ev, CERTIFICATE_HOLDER);

    expect(second).toEqual(first);
  });
});
