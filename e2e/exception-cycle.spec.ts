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
  // A real company's roster can be large and only some vendors have an open
  // deficiency - scanning for one needs more room than the default 30s.
  test.setTimeout(90_000);

  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");
  const account = credentials("MEMBER");
  test.skip(!account, "No activated member account configured for this environment.");

  await signIn(page, account!);
  await page.goto("/dashboard/vendors", { waitUntil: "domcontentloaded" });

  // Vendors are rendered as rows in a <table>, not a role="list" - matching
  // the aria-label every vendor Link already carries is the reliable way to
  // find them, regardless of the surrounding markup. Not every vendor has an
  // open deficiency (a real company's roster is a mix), so this checks each
  // one in turn rather than assuming the first is representative. Collecting
  // hrefs upfront and navigating directly to each (rather than click +
  // goBack, which re-fetches the whole roster every time) keeps a 25-vendor
  // scan well inside the timeout above.
  const vendorLinks = page.getByRole("link", { name: /^Open vendor detail for / });
  // count() does not auto-wait like expect() does, so it can run before the
  // vendor list's own async fetch has resolved - give it a bounded chance to
  // appear before treating an empty result as "genuinely no vendors."
  await vendorLinks
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);
  const vendorCount = await vendorLinks.count();
  test.skip(vendorCount === 0, "This environment has no vendors to open.");

  const hrefs = (
    await Promise.all(
      Array.from({ length: Math.min(vendorCount, 25) }, (_, i) =>
        vendorLinks.nth(i).getAttribute("href"),
      ),
    )
  ).filter((href): href is string => Boolean(href));

  const fileButtons = page.getByRole("button", { name: "File exception" });
  let openDeficiency = false;
  for (const href of hrefs) {
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await fileButtons
      .first()
      .waitFor({ state: "visible", timeout: 1_500 })
      .catch(() => undefined);
    if ((await fileButtons.count()) > 0) {
      openDeficiency = true;
      break;
    }
  }
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
