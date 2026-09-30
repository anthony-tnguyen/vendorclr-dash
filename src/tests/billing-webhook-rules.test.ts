import { describe, expect, it } from "vitest";

import {
  activationFromSubscriptionStatus,
  canManageBilling,
  isEventAlreadyProcessed,
  subscriptionGrantsAccess,
} from "@/domain/billing/webhookRules";

describe("activationFromSubscriptionStatus", () => {
  it("grants access while the subscription is active or trialing", () => {
    expect(activationFromSubscriptionStatus("active")).toBe("activated");
    expect(activationFromSubscriptionStatus("trialing")).toBe("activated");
  });

  it("revokes access when the subscription is definitively dead", () => {
    expect(activationFromSubscriptionStatus("canceled")).toBe("revoked");
    expect(activationFromSubscriptionStatus("unpaid")).toBe("revoked");
    expect(activationFromSubscriptionStatus("incomplete_expired")).toBe("revoked");
  });

  it("leaves activation unchanged during transitional/dunning states", () => {
    // Access is not granted before first payment, nor yanked mid-dunning.
    expect(activationFromSubscriptionStatus("incomplete")).toBeNull();
    expect(activationFromSubscriptionStatus("past_due")).toBeNull();
    expect(activationFromSubscriptionStatus("paused")).toBeNull();
  });

  it("subscriptionGrantsAccess only for active/trialing", () => {
    expect(subscriptionGrantsAccess("active")).toBe(true);
    expect(subscriptionGrantsAccess("trialing")).toBe(true);
    expect(subscriptionGrantsAccess("incomplete")).toBe(false);
    expect(subscriptionGrantsAccess("past_due")).toBe(false);
    expect(subscriptionGrantsAccess("canceled")).toBe(false);
  });
});

describe("isEventAlreadyProcessed (retry safety)", () => {
  it("treats an event as done only once processed_at is set", () => {
    expect(isEventAlreadyProcessed("2026-09-30T00:00:00.000Z")).toBe(true);
  });

  it("does NOT treat a merely-received (unprocessed) event as done", () => {
    // This is the retry bug: a failed attempt leaves the row with a null
    // processed_at, and the redelivery must be reprocessed, not swallowed.
    expect(isEventAlreadyProcessed(null)).toBe(false);
    expect(isEventAlreadyProcessed(undefined)).toBe(false);
    expect(isEventAlreadyProcessed("")).toBe(false);
  });
});

describe("canManageBilling (authorization)", () => {
  it("allows only the owner", () => {
    expect(canManageBilling("owner")).toBe(true);
  });

  it("denies every non-owner role and empty/unknown roles", () => {
    expect(canManageBilling("risk_manager")).toBe(false);
    expect(canManageBilling("project_engineer")).toBe(false);
    expect(canManageBilling("read_only")).toBe(false);
    expect(canManageBilling(null)).toBe(false);
    expect(canManageBilling(undefined)).toBe(false);
    expect(canManageBilling("admin")).toBe(false);
  });
});
