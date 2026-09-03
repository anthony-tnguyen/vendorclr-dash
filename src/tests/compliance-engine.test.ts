import { describe, expect, it } from "vitest";

import {
  computeComplianceItems,
  hasUnclassifiedPolicy,
  isGeneralLiability,
  matchExtractedPolicy,
  type ExistingPolicySnapshot,
  type RequirementSnapshot,
} from "@/workflows/complianceEngine";
import type { ExtractedPolicy } from "@/workflows/insuranceExtractionSchema";

function policy(overrides: Partial<ExtractedPolicy> = {}): ExtractedPolicy {
  return {
    type: "general_liability",
    carrier: "Travelers",
    policy_number: "GL-8841-2266",
    effective_date: "2026-11-30",
    expiration_date: "2027-11-30",
    limits: {},
    additional_insured: true,
    waiver_of_subrogation: true,
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingPolicySnapshot> = {}): ExistingPolicySnapshot {
  return {
    id: "policy-1",
    carrierName: "Travelers",
    policyNumber: "GL-8841-2266",
    expirationDate: "2026-11-30",
    ...overrides,
  };
}

describe("matchExtractedPolicy", () => {
  it("auto-renews when carrier and policy number match and the date moved later", () => {
    const result = matchExtractedPolicy(policy(), existing());
    expect(result).toEqual({ kind: "renew", existingPolicyId: "policy-1" });
  });

  it("is case-insensitive on carrier name but exact on policy number", () => {
    const result = matchExtractedPolicy(
      policy({ carrier: "TRAVELERS" }),
      existing({ carrierName: "travelers" }),
    );
    expect(result.kind).toBe("renew");
  });

  it("routes to new_coverage when the vendor has no existing policy of this type", () => {
    expect(matchExtractedPolicy(policy(), null)).toEqual({ kind: "new_coverage" });
  });

  it("routes to needs_review when the carrier changed", () => {
    const result = matchExtractedPolicy(policy({ carrier: "Hartford" }), existing());
    expect(result.kind).toBe("needs_review");
    if (result.kind === "needs_review") expect(result.reason).toContain("Carrier changed");
  });

  it("routes to needs_review when the policy number changed", () => {
    const result = matchExtractedPolicy(policy({ policy_number: "GL-NEW-999" }), existing());
    expect(result.kind).toBe("needs_review");
    if (result.kind === "needs_review") expect(result.reason).toContain("Policy number changed");
  });

  it("routes to needs_review when the new expiration is not later than the one on file", () => {
    const sameDate = matchExtractedPolicy(policy({ expiration_date: "2026-11-30" }), existing());
    expect(sameDate.kind).toBe("needs_review");

    const earlierDate = matchExtractedPolicy(policy({ expiration_date: "2026-01-01" }), existing());
    expect(earlierDate.kind).toBe("needs_review");
  });

  it("routes to needs_review when carrier or policy number is missing from the extraction", () => {
    expect(matchExtractedPolicy(policy({ carrier: null }), existing()).kind).toBe("needs_review");
    expect(matchExtractedPolicy(policy({ policy_number: null }), existing()).kind).toBe(
      "needs_review",
    );
  });

  it("routes to needs_review when the extracted expiration date is missing or unparseable", () => {
    expect(matchExtractedPolicy(policy({ expiration_date: null }), existing()).kind).toBe(
      "needs_review",
    );
    expect(matchExtractedPolicy(policy({ expiration_date: "not-a-date" }), existing()).kind).toBe(
      "needs_review",
    );
  });

  it("still renews when the existing policy has no expiration date on file to compare against", () => {
    const result = matchExtractedPolicy(policy(), existing({ expirationDate: null }));
    expect(result.kind).toBe("renew");
  });

  describe("company requirements (migration 13)", () => {
    const requirement = (overrides: Partial<RequirementSnapshot> = {}): RequirementSnapshot => ({
      label: "General liability / occurrence",
      limitField: "each_occurrence",
      requiredAmount: 2_000_000,
      ...overrides,
    });

    it("still renews when every requirement is met", () => {
      const result = matchExtractedPolicy(
        policy({ limits: { each_occurrence: 2_000_000 } }),
        existing(),
        [requirement()],
      );
      expect(result.kind).toBe("renew");
    });

    it("routes to needs_review when the extracted limit is below what's required", () => {
      const result = matchExtractedPolicy(
        policy({ limits: { each_occurrence: 1_000_000 } }),
        existing(),
        [requirement()],
      );
      expect(result.kind).toBe("needs_review");
      if (result.kind === "needs_review") {
        expect(result.reason).toContain("General liability / occurrence");
        expect(result.reason).toContain("$2,000,000");
      }
    });

    it("treats a missing extracted limit as not meeting the requirement, not as passing", () => {
      const result = matchExtractedPolicy(policy({ limits: {} }), existing(), [requirement()]);
      expect(result.kind).toBe("needs_review");
      if (result.kind === "needs_review") expect(result.reason).toContain("no amount");
    });

    it("checks every requirement, not just the first", () => {
      const result = matchExtractedPolicy(
        policy({ limits: { each_occurrence: 2_000_000, general_aggregate: 1_000_000 } }),
        existing(),
        [
          requirement({ limitField: "each_occurrence", requiredAmount: 2_000_000 }),
          requirement({
            label: "General aggregate",
            limitField: "general_aggregate",
            requiredAmount: 4_000_000,
          }),
        ],
      );
      expect(result.kind).toBe("needs_review");
      if (result.kind === "needs_review") expect(result.reason).toContain("General aggregate");
    });

    it("still checks requirements even when carrier/policy-number/date already passed cleanly", () => {
      // Regression: a requirement shortfall must not be masked by every
      // other check already having passed - this is specifically the "clean
      // renewal that doesn't meet the limit" case migration 13 exists for.
      const result = matchExtractedPolicy(
        policy({ limits: { each_occurrence: 500_000 } }),
        existing(),
        [requirement()],
      );
      expect(result.kind).toBe("needs_review");
    });

    it("does not check requirements for new_coverage - it never auto-applies anyway", () => {
      const result = matchExtractedPolicy(policy({ limits: {} }), null, [requirement()]);
      expect(result).toEqual({ kind: "new_coverage" });
    });

    it("defaults to no requirements and behaves exactly as before when none are passed", () => {
      const result = matchExtractedPolicy(policy(), existing());
      expect(result.kind).toBe("renew");
    });
  });
});

describe("computeComplianceItems", () => {
  const NOW = new Date("2026-09-01T00:00:00Z");

  it("throws if called on a non-primary policy - it is meaningless there", () => {
    expect(() =>
      computeComplianceItems(
        {
          isPrimaryPolicy: false,
          expirationDate: "2027-01-01",
          additionalInsured: true,
          waiverOfSubrogation: true,
        },
        NOW,
      ),
    ).toThrow();
  });

  it("reports compliant/compliant/compliant when everything is confirmed and far from expiry", () => {
    const result = computeComplianceItems(
      {
        isPrimaryPolicy: true,
        expirationDate: "2027-06-01",
        additionalInsured: true,
        waiverOfSubrogation: true,
      },
      NOW,
    );
    expect(result.coi.status).toBe("compliant");
    expect(result.renewal.status).toBe("compliant");
    expect(result.additionalInsured.status).toBe("compliant");
    expect(result.waiverOfSubrogation.status).toBe("compliant");
  });

  it("reports expiring within the 30-day window", () => {
    const result = computeComplianceItems(
      {
        isPrimaryPolicy: true,
        expirationDate: "2026-09-20",
        additionalInsured: true,
        waiverOfSubrogation: true,
      },
      NOW,
    );
    expect(result.coi.status).toBe("expiring");
    expect(result.renewal.status).toBe("expiring");
  });

  it("reports expired for a past date", () => {
    const result = computeComplianceItems(
      {
        isPrimaryPolicy: true,
        expirationDate: "2026-01-01",
        additionalInsured: true,
        waiverOfSubrogation: true,
      },
      NOW,
    );
    expect(result.coi.status).toBe("expired");
    expect(result.coi.note).toBe("Certificate lapsed");
  });

  it("reports missing (not false) when additional_insured/waiver could not be confirmed", () => {
    const result = computeComplianceItems(
      {
        isPrimaryPolicy: true,
        expirationDate: "2027-06-01",
        additionalInsured: null,
        waiverOfSubrogation: null,
      },
      NOW,
    );
    // null must never silently read as "compliant" - it means "not yet determined".
    expect(result.additionalInsured.status).toBe("missing");
    expect(result.waiverOfSubrogation.status).toBe("missing");
    expect(result.additionalInsured.note).toBeTruthy();
  });

  it("reports missing (not compliant) when the certificate explicitly says no", () => {
    const result = computeComplianceItems(
      {
        isPrimaryPolicy: true,
        expirationDate: "2027-06-01",
        additionalInsured: false,
        waiverOfSubrogation: false,
      },
      NOW,
    );
    expect(result.additionalInsured.status).toBe("missing");
    expect(result.waiverOfSubrogation.status).toBe("missing");
  });

  it("never touches lienWaiver - a COI cannot speak to it", () => {
    const result = computeComplianceItems(
      {
        isPrimaryPolicy: true,
        expirationDate: "2027-06-01",
        additionalInsured: true,
        waiverOfSubrogation: true,
      },
      NOW,
    );
    expect(result).not.toHaveProperty("lienWaiver");
  });
});

describe("hasUnclassifiedPolicy", () => {
  it("is true when any listed policy has an unrecognized type", () => {
    expect(hasUnclassifiedPolicy([policy(), policy({ type: null })])).toBe(true);
  });

  it("is false when every listed policy has a recognized type", () => {
    expect(hasUnclassifiedPolicy([policy(), policy({ type: "workers_compensation" })])).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(hasUnclassifiedPolicy([])).toBe(false);
  });
});

describe("isGeneralLiability", () => {
  it("is true only for general_liability", () => {
    expect(isGeneralLiability("general_liability")).toBe(true);
    expect(isGeneralLiability("workers_compensation")).toBe(false);
    expect(isGeneralLiability(null)).toBe(false);
  });
});
