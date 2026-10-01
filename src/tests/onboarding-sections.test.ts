import { describe, expect, it } from "vitest";

import {
  missingCount,
  missingRequired,
  normalizeCompanyInfo,
  sectionForStep,
  stepIsEmpty,
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

describe("missingCount / missingRequired / stepIsEmpty", () => {
  const empty: WizardSections = {
    companyInfo: {},
    program: {},
    projects: {},
    requirements: {},
  };

  it("counts every blank field when nothing is filled in", () => {
    // 5 company + 4 program + 3 projects + 1 vendors + 2 requirements = 15.
    expect(missingCount(empty)).toBe(15);
  });

  it("drops the count as fields are filled", () => {
    expect(missingCount(sections)).toBeLessThan(missingCount(empty));
  });

  it("flags a blank required company name and clears once provided", () => {
    expect(missingRequired(empty).map((f) => f.key)).toEqual(["companyName"]);
    expect(missingRequired(sections)).toEqual([]);
  });

  it("reports a step empty only when all its fields are blank", () => {
    expect(stepIsEmpty(2, empty)).toBe(true);
    expect(stepIsEmpty(2, sections)).toBe(false);
    // Step 4 (Vendors) owns only the migration note, which `sections` provides.
    expect(stepIsEmpty(4, sections)).toBe(false);
    expect(stepIsEmpty(4, empty)).toBe(true);
    // The review step owns no fields.
    expect(stepIsEmpty(6, empty)).toBe(false);
  });
});
