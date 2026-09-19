import { expect, test } from "@playwright/test";

import { isLiveBuild } from "./helpers";

/**
 * Boot smoke test for the built production bundle (see playwright.config.ts).
 *
 * "/" resolves against the session: a signed-out visitor is sent to the sign-in
 * screen, and a sample-data build (no connection settings) goes straight to the
 * console. Role-based coverage lives in e2e/role-flows.spec.ts.
 */
test("production bundle boots and routes the front door by session", async ({ page }) => {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });

  expect(response, "expected a response from the production server").not.toBeNull();
  expect(response?.status()).toBeLessThan(400);

  const live = await isLiveBuild(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });

  if (live) {
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } else {
    await expect(page).toHaveTitle("Program overview — VendorClr");
  }
});
