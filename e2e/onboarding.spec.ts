import { expect, test } from "@playwright/test";

import { capture, isLiveBuild } from "./helpers";

/**
 * Post-checkout onboarding wizard, exercised against the sample-data build.
 *
 * The full journey (checkout -> onboarding -> submit -> self-review -> staff
 * review) needs real accounts and is covered by the credential-gated role suite;
 * here we verify the wizard's own UX — optionality copy, Skip for now, the
 * stepper and the review summary — which the sample-data build serves without a
 * session. Runs at desktop and at a 390x844 phone viewport.
 */

test.describe("onboarding wizard (sample-data build)", () => {
  test.beforeEach(async ({ page }) => {
    if (await isLiveBuild(page)) {
      test.skip(true, "Live build gates /onboarding behind a real session; see the role suite.");
    }
  });

  test("walks the optional steps and reaches the review", async ({ page }, testInfo) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Company", exact: true })).toBeVisible();
    await expect(page.getByText(/Only your company name is required/i)).toBeVisible();

    await page.getByLabel(/Company name/i).fill("Halstead Builders");
    await page.getByRole("button", { name: /Save & continue/i }).click();

    // Step 2 is optional and empty -> Skip for now.
    await expect(page.getByRole("heading", { name: "Compliance program" })).toBeVisible();
    await page.getByRole("button", { name: /Skip for now/i }).click();

    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await capture(page, testInfo, "onboarding-step-3");
  });

  test("renders the wizard on a 390x844 phone viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Company", exact: true })).toBeVisible();
    await expect(page.getByLabel(/Company name/i)).toBeVisible();
    // No horizontal overflow at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(overflow).toBe(true);
    await capture(page, testInfo, "onboarding-mobile");
  });
});
