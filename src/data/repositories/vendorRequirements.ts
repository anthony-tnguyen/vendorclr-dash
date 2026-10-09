import { getSupabaseClient } from "@/lib/supabase/client";

import {
  REQUIREMENT_CATALOG,
  loadRequirementSettings,
  type RequirementSettingValue,
} from "./requirementSettings";

/**
 * Per-vendor requirement settings, read and written directly on the
 * request-scoped (browser) client.
 *
 * A vendor inherits its company's default requirement profile. This layer lets
 * a customer select/deselect individual requirements (and set limit amounts)
 * for ONE specific vendor; those choices are stored in
 * vendor_requirement_overrides and applied as the highest-precedence layer in
 * resolve_assignment_requirements() (migration 20261009000300), so they
 * genuinely change what a submitted package is evaluated against for that
 * vendor on every assignment.
 *
 * Only a deviation from the company default is stored: a rule whose per-vendor
 * value matches the default carries no override row, so later changes to the
 * company default still flow through to the vendor. Tenancy and authorisation
 * are RLS (owner/risk_manager writes), not this file.
 */

export interface VendorRequirementSettings {
  vendorId: string;
  /** The company default profile's values — the baseline this vendor inherits. */
  baseline: Record<string, RequirementSettingValue>;
  /** Effective per-vendor values: the baseline with this vendor's overrides applied. */
  values: Record<string, RequirementSettingValue>;
  /** Name of the company default profile, for display context. */
  profileName: string;
}

function baselineToValues(
  baseline: Record<string, RequirementSettingValue>,
): Record<string, RequirementSettingValue> {
  const values: Record<string, RequirementSettingValue> = {};
  for (const spec of REQUIREMENT_CATALOG) {
    const base = baseline[spec.key] ?? { enabled: false, amount: null };
    values[spec.key] = { enabled: base.enabled, amount: base.amount };
  }
  return values;
}

export async function loadVendorRequirementSettings(
  companyId: string,
  vendorId: string,
): Promise<VendorRequirementSettings> {
  // The company default profile is the baseline a vendor inherits from.
  const base = await loadRequirementSettings(companyId);
  const baseline = base.values;

  const supabase = getSupabaseClient();
  const overrides = await supabase
    .from("vendor_requirement_overrides")
    .select("rule_key, value")
    .eq("vendor_id", vendorId);
  if (overrides.error) throw new Error(overrides.error.message);

  const values = baselineToValues(baseline);
  for (const row of overrides.data ?? []) {
    // Overrides for rules outside the catalog (e.g. a bespoke rule) are left
    // untouched — the editor only manages catalog rules.
    if (!(row.rule_key in values)) continue;
    const value = (row.value ?? {}) as { required?: boolean; amount?: number | null };
    values[row.rule_key] = {
      enabled: value.required === true,
      amount: value.amount === undefined || value.amount === null ? null : Number(value.amount),
    };
  }

  return { vendorId, baseline, values, profileName: base.profileName };
}

/** Whether a desired per-vendor value differs from the inherited company default. */
function differsFromBaseline(
  specHasAmount: boolean,
  desired: RequirementSettingValue,
  base: RequirementSettingValue,
): boolean {
  const desiredAmount = specHasAmount && desired.enabled ? (desired.amount ?? null) : null;
  const baseAmount = specHasAmount && base.enabled ? (base.amount ?? null) : null;
  return desired.enabled !== base.enabled || desiredAmount !== baseAmount;
}

export async function saveVendorRequirementSettings(
  companyId: string,
  vendorId: string,
  baseline: Record<string, RequirementSettingValue>,
  values: Record<string, RequirementSettingValue>,
): Promise<void> {
  const supabase = getSupabaseClient();

  const toUpsert: Array<{
    company_id: string;
    vendor_id: string;
    rule_key: string;
    value: Record<string, unknown>;
  }> = [];
  const toRemove: string[] = [];

  for (const spec of REQUIREMENT_CATALOG) {
    const desired = values[spec.key] ?? { enabled: false, amount: null };
    const base = baseline[spec.key] ?? { enabled: false, amount: null };

    if (!differsFromBaseline(spec.hasAmount, desired, base)) {
      // Matches the company default — no per-vendor override needed.
      toRemove.push(spec.key);
      continue;
    }

    toUpsert.push({
      company_id: companyId,
      vendor_id: vendorId,
      rule_key: spec.key,
      // Full envelope so a rule the company default does not carry (the
      // vend_extra path in resolve_assignment_requirements) still evaluates.
      value: {
        required: desired.enabled,
        amount: spec.hasAmount && desired.enabled ? (desired.amount ?? null) : null,
        kind: spec.kind,
        policyType: spec.policyType,
        configuration: spec.configuration,
      },
    });
  }

  if (toUpsert.length > 0) {
    const upsert = await supabase
      .from("vendor_requirement_overrides")
      .upsert(toUpsert, { onConflict: "vendor_id,rule_key" });
    if (upsert.error) throw new Error(upsert.error.message);
  }

  if (toRemove.length > 0) {
    const remove = await supabase
      .from("vendor_requirement_overrides")
      .delete()
      .eq("vendor_id", vendorId)
      .in("rule_key", toRemove);
    if (remove.error) throw new Error(remove.error.message);
  }
}
