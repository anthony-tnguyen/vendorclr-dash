import type { InsuranceExtraction } from "./insuranceExtractionSchema";

/**
 * Field-level differences between two extraction revisions - used by the
 * document review screen to show exactly what a reviewer changed relative to
 * the model's own extraction. Pure; both revisions stay untouched in
 * document_extractions (a reviewer edit is always a new row).
 */

export interface ExtractionChange {
  /** Human-readable location, e.g. "Policy 1 · Expiration date". */
  field: string;
  before: string;
  after: string;
}

const POLICY_FIELDS: Array<[string, string]> = [
  ["type", "Coverage type"],
  ["carrier", "Carrier"],
  ["policy_number", "Policy number"],
  ["effective_date", "Effective date"],
  ["expiration_date", "Expiration date"],
  ["limits.each_occurrence", "Each occurrence limit"],
  ["limits.general_aggregate", "General aggregate limit"],
  ["additional_insured", "Additional insured"],
  ["waiver_of_subrogation", "Waiver of subrogation"],
  ["primary_noncontributory", "Primary & non-contributory"],
];

function read(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      value,
    );
}

export function formatExtractionValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value === true) return "Yes";
  if (value === false) return "No";
  return String(value);
}

export function diffExtractions(
  original: InsuranceExtraction | null,
  revised: InsuranceExtraction | null,
): ExtractionChange[] {
  if (!original || !revised) return [];
  const changes: ExtractionChange[] = [];
  const push = (field: string, a: unknown, b: unknown) => {
    const before = formatExtractionValue(a);
    const after = formatExtractionValue(b);
    if (before !== after) changes.push({ field, before, after });
  };

  push("Insured name", original.insured?.name, revised.insured?.name);
  push("Certificate holder", original.certificate_holder?.name, revised.certificate_holder?.name);
  push(
    "Certificate holder address",
    original.certificate_holder?.address,
    revised.certificate_holder?.address,
  );

  const count = Math.max(original.policies.length, revised.policies.length);
  for (let i = 0; i < count; i++) {
    const a = original.policies[i];
    const b = revised.policies[i];
    for (const [path, label] of POLICY_FIELDS) {
      push(
        `Policy ${i + 1} · ${label}`,
        a ? read(a, path) : undefined,
        b ? read(b, path) : undefined,
      );
    }
  }
  return changes;
}
