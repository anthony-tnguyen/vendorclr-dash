import { describe, expect, it } from "vitest";

import {
  validateAssignmentInput,
  validateRequirementProfileInput,
} from "@/workflows/requirementProfiles";

describe("validateRequirementProfileInput", () => {
  it("rejects an empty profile name before mutation", () => {
    expect(() => validateRequirementProfileInput("  ")).toThrow("Profile name is required");
  });

  it("returns a trimmed profile name", () => {
    expect(validateRequirementProfileInput(" High-Risk Subcontractor ")).toBe(
      "High-Risk Subcontractor",
    );
  });
});

describe("validateAssignmentInput", () => {
  it("rejects a negative contract value", () => {
    expect(() => validateAssignmentInput({ vendorId: "vendor-1", contractValue: "-1" })).toThrow(
      "Contract value must be a non-negative whole dollar amount.",
    );
  });
});
