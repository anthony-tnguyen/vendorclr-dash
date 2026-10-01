import type { OnboardingPatch } from "@/data/contracts";

export type Section = Record<string, unknown>;

export interface WizardSections {
  companyInfo: Section;
  program: Section;
  projects: Section;
  requirements: Section;
}

/**
 * The patch persisted when leaving a given wizard step.
 *
 * Step 4 (Vendors) has no section object of its own — its migration note is
 * written into `projects` — so leaving it must persist `projects`. Returning an
 * empty patch (the previous `default`) silently dropped that note on every
 * Save & continue and on submit, which is the P1 data-loss defect.
 */
export function sectionForStep(step: number, sections: WizardSections): OnboardingPatch {
  switch (step) {
    case 1:
      return { companyInfo: sections.companyInfo };
    case 2:
      return { program: sections.program };
    case 3:
    case 4:
      return { projects: sections.projects };
    case 5:
      return { requirements: sections.requirements };
    default:
      return {};
  }
}

/**
 * Compatibility read for the company name during rollout.
 *
 * Self-checkout provisioning historically seeded company_info as `{ name }`, but
 * the wizard reads and writes `companyName`. A migration backfills existing rows,
 * but any row provisioned before it (or by an un-redeployed webhook) still has the
 * old key. Promote `name` to `companyName` on load so the field is never blank
 * when checkout already supplied it, and so the next save standardises the key.
 */
export function normalizeCompanyInfo(raw: Record<string, unknown> | null | undefined): Section {
  const section: Section = { ...(raw ?? {}) };
  const companyName = section.companyName;
  const legacyName = section.name;
  if (
    (typeof companyName !== "string" || companyName === "") &&
    typeof legacyName === "string" &&
    legacyName !== ""
  ) {
    section.companyName = legacyName;
  }
  return section;
}
