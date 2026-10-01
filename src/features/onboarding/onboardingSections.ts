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
export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  kind?: "text" | "list";
}

export interface SectionDef {
  step: number;
  title: string;
  section: keyof WizardSections;
  fields: FieldDef[];
}

/**
 * The single description of every reviewable onboarding field: which wizard step
 * owns it, which section object holds it, its label and whether it is required.
 * Drives the review summary, the missing-item count and the required-field check,
 * so those never drift from the wizard. (Step 4's migration note lives in the
 * `projects` section — see sectionForStep.)
 */
export const SECTION_DEFS: readonly SectionDef[] = [
  {
    step: 1,
    title: "Company",
    section: "companyInfo",
    fields: [
      { key: "companyName", label: "Company name", required: true },
      { key: "primaryContact", label: "Primary contact" },
      { key: "industry", label: "Industry" },
      { key: "location", label: "Location" },
      { key: "approxVendors", label: "Approx. active vendors" },
    ],
  },
  {
    step: 2,
    title: "Compliance program",
    section: "program",
    fields: [
      { key: "vendorTypes", label: "Vendor / subcontractor types" },
      { key: "existingRequirements", label: "Existing insurance requirements" },
      { key: "currentTracking", label: "Current tracking method" },
      { key: "painPoints", label: "Main pain points" },
    ],
  },
  {
    step: 3,
    title: "Projects",
    section: "projects",
    fields: [
      { key: "existingProjects", label: "Existing projects" },
      { key: "projectRequirements", label: "Project-specific requirements" },
      { key: "owners", label: "Project managers / owners" },
    ],
  },
  {
    step: 4,
    title: "Vendors",
    section: "projects",
    fields: [{ key: "migrationNotes", label: "Migration notes" }],
  },
  {
    step: 5,
    title: "Requirements",
    section: "requirements",
    fields: [
      { key: "coverages", label: "Required coverages", kind: "list" },
      { key: "other", label: "Other endorsements / documents" },
    ],
  },
] as const;

/** A field's display value plus whether the customer actually provided it. */
export function fieldDisplay(
  sections: WizardSections,
  def: SectionDef,
  field: FieldDef,
): { value: string; provided: boolean } {
  const raw = sections[def.section][field.key];
  if (field.kind === "list") {
    const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
    return list.length > 0
      ? { value: list.join(", "), provided: true }
      : { value: "Not provided", provided: false };
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  return value ? { value, provided: true } : { value: "Not provided", provided: false };
}

/** How many reviewable fields the customer has left blank. */
export function missingCount(sections: WizardSections): number {
  let missing = 0;
  for (const def of SECTION_DEFS) {
    for (const field of def.fields) {
      if (!fieldDisplay(sections, def, field).provided) missing += 1;
    }
  }
  return missing;
}

/** Whether every field owned by a wizard step is still blank. */
export function stepIsEmpty(step: number, sections: WizardSections): boolean {
  const def = SECTION_DEFS.find((d) => d.step === step);
  if (!def) return false;
  return def.fields.every((field) => !fieldDisplay(sections, def, field).provided);
}

/** Required fields (currently just company name) that are still blank. */
export function missingRequired(sections: WizardSections): FieldDef[] {
  const out: FieldDef[] = [];
  for (const def of SECTION_DEFS) {
    for (const field of def.fields) {
      if (field.required && !fieldDisplay(sections, def, field).provided) out.push(field);
    }
  }
  return out;
}

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
