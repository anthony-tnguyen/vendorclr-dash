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

  const correctionButtons = page.getByRole("button", { name: "Request correction" });
  let openDeficiency = false;
  for (const href of hrefs) {
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await correctionButtons
      .first()
      .waitFor({ state: "visible", timeout: 1_500 })
      .catch(() => undefined);
    if ((await correctionButtons.count()) > 0) {
      openDeficiency = true;
      break;
    }
  }
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
