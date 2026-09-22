import { describe, expect, it } from "vitest";

import {
  DEFICIENCY_STATUS_LABELS,
  escalationLabel,
  requiredVsSubmitted,
  requirementHeadline,
} from "@/domain/compliance/deficiencyDisplay";

/**
 * Required-vs-submitted rendering for the contractor-facing deficiency UI.
 * The engine's own value semantics are proven in the database tests; this
 * pins what a contractor actually reads.
 */

describe("requiredVsSubmitted", () => {
  it("shows required and submitted limits as currency", () => {
    expect(
      requiredVsSubmitted({
        kind: "limit",
        policyType: "general_liability",
        expected: { amount: 2_000_000 },
        observed: { amount: 1_000_000 },
      }),
    ).toEqual({ required: "$2,000,000", submitted: "$1,000,000" });
  });

  it("says so in words when the submitted amount was not found", () => {
    const result = requiredVsSubmitted({
      kind: "limit",
      policyType: "general_liability",
      expected: { amount: 2_000_000 },
      observed: null,
    });
    expect(result.required).toBe("$2,000,000");
    expect(result.submitted).toBe("Not shown on the certificate");
  });

  it("renders endorsement requirements with their shown/not-shown state", () => {
    expect(
      requiredVsSubmitted({
        kind: "endorsement",
        policyType: "general_liability",
        expected: { endorsementField: "additional_insured" },
        observed: { additional_insured: false },
      }),
    ).toEqual({ required: "Additional Insured", submitted: "Not shown on the certificate" });
    expect(
      requiredVsSubmitted({
        kind: "endorsement",
        policyType: "general_liability",
        expected: { endorsementField: "waiver_of_subrogation" },
        observed: { waiver_of_subrogation: true },
      }).submitted,
    ).toBe("Shown on the certificate");
  });

  it("renders a missing document as Missing", () => {
    expect(
      requiredVsSubmitted({
        kind: "document",
        policyType: null,
        expected: { documentKind: "certificate_of_insurance" },
        observed: null,
      }),
    ).toEqual({ required: "Certificate Of Insurance", submitted: "Missing" });
  });

  it("renders certificate holder values", () => {
    expect(
      requiredVsSubmitted({
        kind: "certificate_holder",
        policyType: null,
        expected: { name: "Halstead Builders LLC" },
        observed: { name: "Corbett Steel" },
      }),
    ).toEqual({ required: "Halstead Builders LLC", submitted: "Corbett Steel" });
  });
});

describe("requirementHeadline", () => {
  it("joins policy type and endorsement field", () => {
    expect(
      requirementHeadline({
        requirementKey: "gl_additional_insured",
        kind: "endorsement",
        policyType: "general_liability",
        expected: { endorsementField: "additional_insured" },
      }),
    ).toBe("General Liability — Additional Insured");
  });

  it("falls back to the policy type for limits", () => {
    expect(
      requirementHeadline({
        requirementKey: "gl_each_occurrence",
        kind: "limit",
        policyType: "general_liability",
        expected: { amount: 2_000_000 },
      }),
    ).toBe("General Liability");
  });
});

describe("labels", () => {
  it("never exposes the bare word 'open' for a deficiency a contractor must fix", () => {
    expect(DEFICIENCY_STATUS_LABELS["open"]).toBe("Needs correction");
    expect(DEFICIENCY_STATUS_LABELS["resolved"]).toBe("Resolved");
    expect(DEFICIENCY_STATUS_LABELS["waived"]).toBe("Waived — exception");
  });

  it("names the fixed 3/7/14-day escalation thresholds", () => {
    expect(escalationLabel(0)).toBe("No reminder sent yet");
    expect(escalationLabel(1)).toBe("3-day reminder sent");
    expect(escalationLabel(2)).toBe("7-day reminder sent");
    expect(escalationLabel(3)).toBe("14-day reminder sent");
  });
});
