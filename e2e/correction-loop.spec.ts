import { expect, test } from "@playwright/test";

import { capture, credentials, isLiveBuild, signIn } from "./helpers";

/**
 * Contractor-side correction journey, against a live build with a member
 * account on an environment that has vendor data:
 *
 *   open a vendor/project -> view a deficiency -> request correction
 *   -> the escalation clock starts and the request shows in history.
 *
 * The vendor's replacement upload and the re-evaluation that resolves the
 * deficiency need the vendor-side magic link and the document pipeline; those
 * halves are covered end-to-end in supabase/tests/compliance-cases.test.ts
 * and compliance-case-escalation.test.ts against real Postgres. This spec
 * skips when the build is demo-only, no member credentials are configured,
 * or the environment has no vendor with an open deficiency - it never fakes
 * state.
 */

test("a contractor requests correction on an open deficiency", async ({ page }, testInfo) => {
  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");
  const account = credentials("MEMBER");
  test.skip(!account, "No activated member account configured for this environment.");

  await signIn(page, account!);
  await page.goto("/dashboard/vendors", { waitUntil: "domcontentloaded" });

  const vendorLink = page.getByRole("list").getByRole("link").filter({ hasText: /./ }).first();
  const anyVendor = (await vendorLink.count()) > 0;
  test.skip(!anyVendor, "This environment has no vendors to open.");

  await vendorLink.click();
  await page.waitForLoadState("domcontentloaded");

  const correctionButtons = page.getByRole("button", { name: "Request correction" });
  const openDeficiency = (await correctionButtons.count()) > 0;
  test.skip(!openDeficiency, "This environment has no open deficiency to correct.");

  await correctionButtons.first().click();
  const form = page.getByRole("form", { name: "Request correction" });
  await expect(form).toBeVisible();
  await expect(form.getByTestId("correction-instructions-preview")).toBeVisible();

  const recipient = form.locator('input[type="checkbox"]:not(:disabled)').first();
  await recipient.check();
  await form.getByRole("button", { name: /Send to 1 recipient/ }).click();

  await expect(page.getByText(/Correction request sent to 1 recipient/)).toBeVisible();
  await expect(page.getByTestId("deficiency-row").first()).toContainText(/Correction requested/);
  await capture(page, testInfo, "correction-requested");
});
