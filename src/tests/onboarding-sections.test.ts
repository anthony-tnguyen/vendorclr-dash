import { describe, expect, it } from "vitest";

import {
  normalizeCompanyInfo,
  sectionForStep,
  type WizardSections,
} from "@/features/onboarding/onboardingSections";

const sections: WizardSections = {
  companyInfo: { companyName: "Halstead" },
  program: { painPoints: "chasing COIs" },
  projects: { existingProjects: "Pier 9", migrationNotes: "list lives in Procore" },
  requirements: { coverages: ["General Liability"] },
};

describe("sectionForStep", () => {
  it("persists the matching section for steps 1-3 and 5", () => {
    expect(sectionForStep(1, sections)).toEqual({ companyInfo: sections.companyInfo });
    expect(sectionForStep(2, sections)).toEqual({ program: sections.program });
    expect(sectionForStep(3, sections)).toEqual({ projects: sections.projects });
    expect(sectionForStep(5, sections)).toEqual({ requirements: sections.requirements });
  });

  it("persists `projects` when leaving step 4 so the migration note survives (P1 regression)", () => {
    // The bug: step 4 returned {} and dropped the note written into `projects`.
    const patch = sectionForStep(4, sections);
    expect(patch.projects).toBeDefined();
    expect(patch.projects).toHaveProperty("migrationNotes", "list lives in Procore");
  });

  it("returns an empty patch for the review step (6)", () => {
    expect(sectionForStep(6, sections)).toEqual({});
  });
});

describe("normalizeCompanyInfo", () => {
  it("promotes a legacy `name` to `companyName` when companyName is absent (P1 regression)", () => {
    expect(normalizeCompanyInfo({ name: "Acme Builders" })).toEqual({
      name: "Acme Builders",
      companyName: "Acme Builders",
    });
  });

  it("prefers an existing companyName and leaves it untouched", () => {
    expect(normalizeCompanyInfo({ name: "Legacy", companyName: "Current" })).toEqual({
      name: "Legacy",
      companyName: "Current",
    });
  });

  it("is a no-op for an already-normalised or empty section", () => {
    expect(normalizeCompanyInfo({ companyName: "Current" })).toEqual({ companyName: "Current" });
    expect(normalizeCompanyInfo({})).toEqual({});
    expect(normalizeCompanyInfo(null)).toEqual({});
    expect(normalizeCompanyInfo(undefined)).toEqual({});
  });

  it("does not promote a blank legacy name", () => {
    expect(normalizeCompanyInfo({ name: "" })).toEqual({ name: "" });
  });
});
