/**
 * The plan catalogue — the single source of truth for VendorClr's pricing
 * structure inside the app.
 *
 * The four plan ids match the `plan` CHECK on `companies` / `activation_codes`
 * and the seeded rows in `plan_limits`
 * (supabase/migrations/20260929000100_self_checkout_billing_and_onboarding.sql),
 * and the Stripe lookup keys match the sandbox / live prices. Keep all three in
 * sync by hand — nothing enforces it automatically.
 *
 * The Stripe Edge Functions (supabase/functions/create-checkout, stripe-webhook)
 * run in Deno and cannot import this module, so they derive the lookup key from
 * the plan id with the same `vendorclr_<plan>_monthly` convention encoded here.
 */

export type PlanId = "core" | "operations" | "scale" | "enterprise";

export const PLAN_IDS = ["core", "operations", "scale", "enterprise"] as const;

export type ManagedServiceLevel = "basic" | "full" | "priority" | "custom";

export interface PlanDefinition {
  id: PlanId;
  label: string;
  /** Public monthly price in whole USD, or null for custom (Enterprise). */
  priceMonthly: number | null;
  /** Stripe price lookup key, or null when there is no self-checkout price. */
  stripeLookupKey: string | null;
  /** Active-vendor ceiling; null = unlimited. */
  maxActiveVendors: number | null;
  /** Internal-user ceiling; null = unlimited. */
  maxInternalUsers: number | null;
  managedService: ManagedServiceLevel;
  /** Whether a customer can subscribe to this plan through self-checkout. */
  selfCheckout: boolean;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  core: {
    id: "core",
    label: "Core",
    priceMonthly: 149,
    stripeLookupKey: "vendorclr_core_monthly",
    maxActiveVendors: 75,
    maxInternalUsers: 3,
    managedService: "basic",
    selfCheckout: true,
  },
  operations: {
    id: "operations",
    label: "Operations",
    priceMonthly: 349,
    stripeLookupKey: "vendorclr_operations_monthly",
    maxActiveVendors: 200,
    maxInternalUsers: 10,
    managedService: "full",
    selfCheckout: true,
  },
  scale: {
    id: "scale",
    label: "Scale",
    priceMonthly: 449,
    stripeLookupKey: "vendorclr_scale_monthly",
    maxActiveVendors: 300,
    maxInternalUsers: null,
    managedService: "priority",
    selfCheckout: true,
  },
  enterprise: {
    id: "enterprise",
    label: "Enterprise",
    priceMonthly: null,
    stripeLookupKey: null,
    maxActiveVendors: null,
    maxInternalUsers: null,
    managedService: "custom",
    selfCheckout: false,
  },
};

/** Plans a customer can subscribe to without talking to sales. */
export const SELF_CHECKOUT_PLAN_IDS: PlanId[] = PLAN_IDS.filter((id) => PLANS[id].selfCheckout);

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

export function isSelfCheckoutPlan(value: string): value is PlanId {
  return isPlanId(value) && PLANS[value].selfCheckout;
}

/** Human label for a plan id; falls back to the raw value if it is unknown. */
export function planLabel(value: string): string {
  return isPlanId(value) ? PLANS[value].label : value;
}

const MANAGED_SERVICE_LABELS: Record<ManagedServiceLevel, string> = {
  basic: "Basic managed service",
  full: "Full managed service",
  priority: "Priority managed service",
  custom: "Custom managed service",
};

export function managedServiceLabel(level: ManagedServiceLevel): string {
  return MANAGED_SERVICE_LABELS[level];
}
