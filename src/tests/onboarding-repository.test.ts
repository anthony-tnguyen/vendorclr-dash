import { describe, expect, it } from "vitest";

import { createDemoRepository } from "@/data/demoRepository";

describe("onboarding repository (demo)", () => {
  it("starts with an empty step-1 onboarding state", async () => {
    const repo = createDemoRepository();
    const state = await repo.getOnboarding();
    expect(state).not.toBeNull();
    expect(state?.currentStep).toBe(1);
    expect(state?.submittedAt).toBeNull();
    expect(state?.companyInfo).toEqual({});
  });

  it("saves only the provided fields and advances the step", async () => {
    const repo = createDemoRepository();
    await repo.saveOnboarding({ currentStep: 2, companyInfo: { companyName: "Halstead" } });
    const state = await repo.getOnboarding();
    expect(state?.currentStep).toBe(2);
    expect(state?.companyInfo).toEqual({ companyName: "Halstead" });
    // Untouched sections stay empty rather than being wiped.
    expect(state?.program).toEqual({});

    await repo.saveOnboarding({ program: { painPoints: "chasing COIs" } });
    const next = await repo.getOnboarding();
    expect(next?.companyInfo).toEqual({ companyName: "Halstead" });
    expect(next?.program).toEqual({ painPoints: "chasing COIs" });
    expect(next?.currentStep).toBe(2);
  });

  it("marks the onboarding submitted", async () => {
    const repo = createDemoRepository();
    await repo.submitOnboarding();
    const state = await repo.getOnboarding();
    expect(state?.submittedAt).not.toBeNull();
  });

  it("reports vendor usage against the plan ceiling", async () => {
    const repo = createDemoRepository();
    const usage = await repo.getVendorUsage();
    expect(usage.maxActiveVendors).toBe(75);
    expect(usage.activeVendors).toBeGreaterThanOrEqual(0);
    expect(usage.utilization).toBeGreaterThanOrEqual(0);
    // Utilization is the count over the ceiling, not a hard-coded zero.
    expect(usage.utilization).toBeCloseTo(usage.activeVendors / 75, 4);
  });

  it("lists onboarding reviews for staff, including the wizard answers", async () => {
    const repo = createDemoRepository();
    const reviews = await repo.listOnboardingReviews();
    expect(reviews.length).toBeGreaterThan(0);
    // Only companies still onboarding / under review belong here.
    expect(reviews.every((r) => r.serviceStatus !== "live")).toBe(true);
    const submitted = reviews.find((r) => r.serviceStatus === "in_review");
    expect(submitted).toBeDefined();
    expect(submitted?.submittedAt).not.toBeNull();
    expect(submitted?.companyInfo).toMatchObject({ companyName: expect.any(String) });
  });
});
