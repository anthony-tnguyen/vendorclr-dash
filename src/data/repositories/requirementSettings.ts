import type { PolicyKind } from "@/domain/construction/types";
import type { CompanyRole, PolicyType } from "@/data/dbTypeAliases";
import { getSupabaseClient } from "@/lib/supabase/client";

/**
 * Company insurance-requirement settings, read and written directly on the
 * request-scoped (browser) client.
 *
 * Tenancy and authorisation are RLS, not this file: requirement_profiles and
 * requirement_profile_rules only accept writes from has_company_role(company,
 * ['owner','risk_manager']). The `canEdit` helper below exists so the UI does
 * not offer a control the database will refuse - it is not the boundary.
 *
 * Every rule written here uses the same rule_key vocabulary the compliance
 * engine reads (src/domain/compliance/evaluatePackage.ts consumes
 * configuration.limitField / endorsementField / documentKind), so a
 * requirement configured on this page is genuinely what a submitted package
 * gets evaluated against.
 */

export interface RequirementRuleSpec {
  key: string;
  label: string;
  description: string;
  kind: PolicyKind;
  policyType: PolicyType | null;
  configuration: Record<string, unknown>;
  /** Limit rules carry a dollar minimum; endorsements and documents do not. */
  hasAmount: boolean;
  group: "coverage" | "endorsement" | "certificate" | "document";
}

function limitRule(
  policyType: PolicyType,
  limitField: "each_occurrence_limit" | "general_aggregate_limit",
  label: string,
  description: string,
): RequirementRuleSpec {
  return {
    key: `${policyType}_${limitField}`,
    label,
    description,
    kind: "limit",
    policyType,
    configuration: { limitField },
    hasAmount: true,
    group: "coverage",
  };
}

function endorsementRule(
  endorsementField: string,
  label: string,
  description: string,
): RequirementRuleSpec {
  return {
    key: `general_liability_${endorsementField}`,
    label,
    description,
    kind: "endorsement",
    policyType: "general_liability",
    configuration: { endorsementField },
    hasAmount: false,
    group: "endorsement",
  };
}

function documentRule(documentKind: string, label: string, description: string): RequirementRuleSpec {
  return {
    key: `document_${documentKind}`,
    label,
    description,
    kind: "document",
    policyType: null,
    configuration: { documentKind },
    hasAmount: false,
    group: "document",
  };
}

/** The line items the Settings page can configure. Custom rules are preserved untouched. */
export const REQUIREMENT_CATALOG: RequirementRuleSpec[] = [
  limitRule(
    "general_liability",
    "each_occurrence_limit",
    "General liability — each occurrence",
    "Minimum per-claim limit on the vendor's general liability policy.",
  ),
  limitRule(
    "general_liability",
    "general_aggregate_limit",
    "General liability — general aggregate",
    "Minimum total limit across the policy term.",
  ),
  limitRule(
    "workers_compensation",
    "each_occurrence_limit",
    "Workers compensation",
    "Minimum employers-liability limit shown on the workers compensation line.",
  ),
  limitRule(
    "commercial_auto",
    "each_occurrence_limit",
    "Commercial auto",
    "Minimum combined single limit for owned, hired and non-owned autos.",
  ),
  limitRule(
    "umbrella",
    "each_occurrence_limit",
    "Umbrella / excess",
    "Minimum umbrella limit sitting above the scheduled underlying policies.",
  ),
  limitRule(
    "professional_liability",
    "each_occurrence_limit",
    "Professional liability",
    "Minimum limit for design or professional services exposure.",
  ),
  limitRule(
    "pollution_liability",
    "each_occurrence_limit",
    "Pollution liability",
    "Minimum limit for environmental or pollution exposure.",
  ),
  endorsementRule(
    "additional_insured",
    "Additional insured",
    "The certificate must show additional-insured status for your company.",
  ),
  endorsementRule(
    "additional_insured_ongoing_operations",
    "Additional insured — ongoing operations",
    "Typically evidenced by a CG 20 10 endorsement.",
  ),
  endorsementRule(
    "additional_insured_completed_operations",
    "Additional insured — completed operations",
    "Typically evidenced by a CG 20 37 endorsement.",
  ),
  endorsementRule(
    "waiver_of_subrogation",
    "Waiver of subrogation",
    "The insurer waives its right to recover against your company.",
  ),
  endorsementRule(
    "primary_noncontributory",
    "Primary and non-contributory",
    "The vendor's policy responds first, ahead of your own coverage.",
  ),
  {
    key: "certificate_holder_named",
    label: "Certificate holder named correctly",
    description:
      "The certificate must name the project's certificate holder exactly as configured on the project.",
    kind: "certificate_holder",
    policyType: null,
    configuration: {},
    hasAmount: false,
    group: "certificate",
  },
  documentRule(
    "certificate_of_insurance",
    "Certificate of insurance",
    "A current ACORD 25 (or equivalent) certificate must be on file.",
  ),
  documentRule(
    "additional_insured_endorsement",
    "Additional insured endorsement page",
    "The endorsement form itself, not just the certificate checkbox.",
  ),
  documentRule(
    "waiver_of_subrogation_endorsement",
    "Waiver of subrogation endorsement page",
    "The endorsement form evidencing the waiver.",
  ),
  documentRule(
    "primary_noncontributory_endorsement",
    "Primary and non-contributory endorsement page",
    "The endorsement form evidencing primary and non-contributory wording.",
  ),
];

export interface RequirementSettingValue {
  enabled: boolean;
  /** Dollars, as entered. Null for a rule that carries no amount. */
  amount: number | null;
}

export interface CustomRequirementRule {
  key: string;
  policyType: string | null;
  kind: string;
  required: boolean;
  amount: number | null;
}

export interface RequirementSettings {
  profileId: string;
  profileName: string;
  values: Record<string, RequirementSettingValue>;
  /** Rules on the profile that are not in the catalog above - shown, never rewritten. */
  customRules: CustomRequirementRule[];
}

export interface RequirementAuditEntry {
  id: string;
  action: string;
  createdAt: string;
  ruleKey: string;
  amount: number | null;
  previousAmount: number | null;
  required: boolean | null;
}

/** Presentation gate only; RLS re-checks every write. */
export function canEditRequirements(role: CompanyRole | null): boolean {
  return role === "owner" || role === "risk_manager";
}

function emptyValues(): Record<string, RequirementSettingValue> {
  const values: Record<string, RequirementSettingValue> = {};
  for (const spec of REQUIREMENT_CATALOG) {
    values[spec.key] = { enabled: false, amount: null };
  }
  return values;
}

export async function loadRequirementSettings(companyId: string): Promise<RequirementSettings> {
  const supabase = getSupabaseClient();

  const profileResult = await supabase
    .from("requirement_profiles")
    .select("id, name")
    .eq("company_id", companyId)
    .eq("is_company_default", true)
    .maybeSingle();

  if (profileResult.error) throw new Error(profileResult.error.message);
  if (!profileResult.data) {
    throw new Error(
      "This company has no default requirement profile yet. Contact VendorClr support so one can be created.",
    );
  }

  const rulesResult = await supabase
    .from("requirement_profile_rules")
    .select("rule_key, policy_type, rule_kind, required, amount")
    .eq("profile_id", profileResult.data.id);

  if (rulesResult.error) throw new Error(rulesResult.error.message);

  const values = emptyValues();
  const customRules: CustomRequirementRule[] = [];
  const known = new Set(REQUIREMENT_CATALOG.map((spec) => spec.key));

  for (const row of rulesResult.data ?? []) {
    if (known.has(row.rule_key)) {
      values[row.rule_key] = {
        enabled: row.required === true,
        amount: row.amount === null ? null : Number(row.amount),
      };
      continue;
    }
    customRules.push({
      key: row.rule_key,
      policyType: row.policy_type,
      kind: row.rule_kind,
      required: row.required === true,
      amount: row.amount === null ? null : Number(row.amount),
    });
  }

  return {
    profileId: profileResult.data.id,
    profileName: profileResult.data.name,
    values,
    customRules,
  };
}

export function validateRequirementSettings(
  values: Record<string, RequirementSettingValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const spec of REQUIREMENT_CATALOG) {
    const value = values[spec.key];
    if (!value?.enabled || !spec.hasAmount) continue;
    const amount = value.amount;
    if (amount === null || Number.isNaN(amount)) {
      errors[spec.key] = "Enter a minimum amount, or turn this requirement off.";
    } else if (amount <= 0) {
      errors[spec.key] = "Enter an amount greater than zero.";
    } else if (!Number.isInteger(amount)) {
      errors[spec.key] = "Enter a whole dollar amount.";
    }
  }
  return errors;
}

export async function saveRequirementSettings(
  companyId: string,
  settings: RequirementSettings,
  values: Record<string, RequirementSettingValue>,
): Promise<void> {
  const supabase = getSupabaseClient();

  const toUpsert = REQUIREMENT_CATALOG.filter((spec) => values[spec.key]?.enabled).map((spec) => ({
    company_id: companyId,
    profile_id: settings.profileId,
    rule_key: spec.key,
    policy_type: spec.policyType,
    rule_kind: spec.kind,
    required: true,
    amount: spec.hasAmount ? (values[spec.key]?.amount ?? null) : null,
    configuration: spec.configuration,
  }));

  const toRemove = REQUIREMENT_CATALOG.filter(
    (spec) => !values[spec.key]?.enabled && settings.values[spec.key]?.enabled,
  ).map((spec) => spec.key);

  if (toUpsert.length > 0) {
    const upsert = await supabase
      .from("requirement_profile_rules")
      .upsert(toUpsert, { onConflict: "profile_id,rule_key" });
    if (upsert.error) throw new Error(upsert.error.message);
  }

  if (toRemove.length > 0) {
    const remove = await supabase
      .from("requirement_profile_rules")
      .delete()
      .eq("profile_id", settings.profileId)
      .in("rule_key", toRemove);
    if (remove.error) throw new Error(remove.error.message);
  }
}

export async function loadRequirementAuditHistory(
  companyId: string,
  limit = 12,
): Promise<RequirementAuditEntry[]> {
  const supabase = getSupabaseClient();
  const result = await supabase
    .from("audit_log")
    .select("id, action, created_at, detail")
    .eq("company_id", companyId)
    .eq("target_type", "requirement_profile")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (result.error) throw new Error(result.error.message);

  return (result.data ?? []).map((row) => {
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    const asNumber = (input: unknown) => (typeof input === "number" ? input : null);
    return {
      id: row.id,
      action: row.action,
      createdAt: row.created_at,
      ruleKey: typeof detail["rule_key"] === "string" ? (detail["rule_key"] as string) : "unknown",
      amount: asNumber(detail["amount"]),
      previousAmount: asNumber(detail["previous_amount"]),
      required: typeof detail["required"] === "boolean" ? (detail["required"] as boolean) : null,
    };
  });
}

export function ruleLabel(key: string): string {
  return REQUIREMENT_CATALOG.find((spec) => spec.key === key)?.label ?? key;
}
