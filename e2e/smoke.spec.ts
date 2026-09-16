import { expect, test } from "@playwright/test";

/**
 * Minimal placeholder smoke test for Task 0A (release controls).
 *
 * This exists only to make the CI `e2e-smoke` job real: it boots the built
 * production bundle (see playwright.config.ts) and confirms the app shell
 * renders end-to-end through an actual browser, rather than the job running
 * against nothing. Task 0B (Engineer B) owns full role-based smoke coverage
 * under e2e/** and is expected to expand this file considerably; do not
 * treat this as complete coverage.
 */
test("production bundle boots and serves the dashboard shell", async ({ page }) => {
  const response = await page.goto("/");

  expect(response, "expected a response from the production server").not.toBeNull();
  expect(response?.status()).toBeLessThan(400);
  // "/" redirects to "/dashboard" (see src/routes/index.tsx), which sets its
  // own <title> (src/routes/dashboard.index.tsx) distinct from __root.tsx's.
  await expect(page).toHaveTitle("Program overview — VendorClr");
});
