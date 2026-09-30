/**
 * Pure billing/webhook decision rules.
 *
 * These encode the money-path decisions that must stay correct and testable:
 * when a subscription grants or revokes console access, when a Stripe webhook
 * event counts as already handled, and who may manage billing. The Stripe Edge
 * Functions run in Deno and cannot import this module, so `stripe-webhook`,
 * `create-checkout` and `billing-portal` keep byte-identical copies of these
 * rules inline (same pattern as operationalLog.ts). If one changes, change the
 * others — these tests are the source of truth for the intended behavior.
 */

/** Mirrors companies.subscription_status (Stripe's own vocabulary). */
export type StripeSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

/** companies.activation_status — controls whether the console is open. */
export type CompanyActivation = "demo" | "activated" | "revoked";

/**
 * The activation a subscription status implies, or null to leave activation
 * unchanged. Access is granted only while the subscription is paid and usable
 * (active/trialing); it is withdrawn when the subscription is definitively dead
 * (canceled/unpaid/incomplete_expired). past_due, incomplete and paused are
 * transitional — Stripe is still dunning or awaiting a first payment — so we
 * record the status but do not flip access either way (a grace window that a
 * later invoice.paid or subscription.deleted resolves).
 */
export function activationFromSubscriptionStatus(status: string): CompanyActivation | null {
  if (status === "active" || status === "trialing") return "activated";
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
    return "revoked";
  }
  return null;
}

/** A subscription that entitles the buyer to their workspace right now. */
export function subscriptionGrantsAccess(status: string): boolean {
  return activationFromSubscriptionStatus(status) === "activated";
}

/**
 * Whether a recorded Stripe event has already been fully processed. Existence of
 * the stripe_events row is NOT enough — the row is written on receipt, before
 * provisioning. Only a set processed_at means provisioning finished, so a retry
 * after a failed attempt (processed_at still null) must be reprocessed.
 */
export function isEventAlreadyProcessed(processedAt: string | null | undefined): boolean {
  return typeof processedAt === "string" && processedAt.length > 0;
}

/** Only a company owner may open the Stripe billing portal or manage billing. */
export function canManageBilling(role: string | null | undefined): boolean {
  return role === "owner";
}
