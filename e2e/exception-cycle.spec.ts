import { expect, test } from "@playwright/test";

import { capture, credentials, isLiveBuild, signIn } from "./helpers";

/**
 * Exception journey, against a live build with an owner/risk_manager account:
 *
 *   open deficiency -> approve an exception with the remaining-risk
 *   acknowledgement -> the active waiver is shown with approver, dates and
 *   reason.
 *
 * Expiry and the automatic reopen are driven by the housekeeping sweep, not
 * by wall-clock waiting in a browser; that half is covered in
 * supabase/tests/compliance-case-escalation.test.ts (expired exception
 * included by the sweep view, deficiency reopened, audit row written). This
 * spec skips when the build is demo-only, credentials are absent, the member
 * lacks the approver role, or the environment has no open deficiency.
 */

test("an authorized approver grants an exception with a risk acknowledgement", async ({
  page,
}, testInfo) => {
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

  const fileButtons = page.getByRole("button", { name: "File exception" });
  const openDeficiency = (await fileButtons.count()) > 0;
  test.skip(!openDeficiency, "No open deficiency (or the member is not an approver).");

  await fileButtons.first().click();
  const form = page.getByRole("form", { name: "Approve exception" });
  await expect(form).toBeVisible();

  await form.getByLabel("Reason").fill("Policy renewal in transit with the broker.");
  await form.getByLabel("Expiration date").fill("2026-12-31");
  // The approval is refused until the acknowledgement is explicit.
  await expect(form.getByRole("button", { name: "Approve exception" })).toBeDisabled();
  await form.getByTestId("risk-acknowledgement").locator("input").check();
  await form.getByRole("button", { name: "Approve exception" }).click();

  await expect(page.getByTestId("exception-state").first()).toBeVisible();
  await expect(page.getByText(/Policy renewal in transit/).first()).toBeVisible();
  await capture(page, testInfo, "exception-approved");
});
