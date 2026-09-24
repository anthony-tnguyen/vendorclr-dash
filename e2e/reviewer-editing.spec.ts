import { expect, test } from "@playwright/test";

import { capture, credentials, isLiveBuild, signIn } from "./helpers";

/**
 * open document review -> edit extracted field -> (approve)
 * -> reviewer revision created -> original model extraction unchanged.
 *
 * Needs E2E_STAFF_* and an environment with at least one document awaiting
 * review that has an extraction. Approval changes the vendor's policies, so
 * it only runs when E2E_ALLOW_REVIEW_APPROVAL=true; otherwise the spec stops
 * after proving the revision behavior. The database-level invariant (a new
 * immutable row; UPDATE rejected) is proven in
 * supabase/tests/document-extractions.test.ts, and the UI flow including
 * approval in src/tests/document-review-editing.test.tsx.
 */

test("a reviewer corrects an extraction without overwriting the model's", async ({
  page,
}, testInfo) => {
  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");
  const account = credentials("STAFF");
  test.skip(!account, "No staff account configured for this environment.");

  await signIn(page, account!);
  await page.goto("/dashboard/admin/compliance", { waitUntil: "domcontentloaded" });
  const preview = page.getByRole("button", { name: "Preview as administrator" });
  // Whether this button renders at all depends on the async is_platform_admin()
  // identity check (see App.tsx's loadIdentity()) - a staff account starts in
  // the "customer" role regardless, and only sees this button, and the admin
  // console, once that resolves. count() does not wait for it the way
  // expect() does, so check for it explicitly first.
  await preview.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  if (await preview.count()) await preview.first().click();

  const openLink = page.getByRole("link", { name: /^Open review for / }).first();
  // count() does not auto-wait like expect() does, so it can run before the
  // queue's own async fetch has resolved - give it a bounded chance first.
  await openLink.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  test.skip((await openLink.count()) === 0, "This environment has no documents awaiting review.");
  await openLink.click();

  const correct = page.getByRole("button", { name: "Correct extraction" });
  await correct.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  test.skip(
    (await correct.count()) === 0,
    "The first queued document has no extraction to correct.",
  );

  const revisions = page.getByTestId("extraction-revisions");
  const before = await revisions.getByRole("listitem").count();

  await correct.click();
  const form = page.getByRole("form", { name: "Edit extracted fields" });
  const carrier = form.getByLabel("Carrier").first();
  const original = await carrier.inputValue();
  const edited = `${original || "Carrier"} (reviewed ${Date.now().toString(36)})`;
  await carrier.fill(edited);
  await form.getByRole("button", { name: "Save reviewer revision" }).click();

  await expect(page.getByRole("status").first()).toContainText(
    "The model's original extraction is unchanged",
  );
  await expect(revisions.getByRole("listitem")).toHaveCount(before + 1);
  await expect(revisions.getByRole("listitem").last()).toContainText("Reviewer revision");
  await expect(revisions.getByRole("listitem").first()).toContainText("Model extraction");

  const change = page
    .getByTestId("reviewer-changes")
    .getByRole("row", { name: /Carrier/ })
    .first();
  await expect(change).toContainText(edited);
  if (original) await expect(change).toContainText(original);
  await capture(page, testInfo, "reviewer-revision");

  if (process.env["E2E_ALLOW_REVIEW_APPROVAL"] !== "true") {
    testInfo.annotations.push({
      type: "not-run",
      description:
        "Approval skipped: set E2E_ALLOW_REVIEW_APPROVAL=true to approve in this environment",
    });
    return;
  }
  await page.getByRole("button", { name: /Review \d+ selected line/ }).click();
  await page.getByRole("button", { name: "Confirm & apply" }).click();
  await expect(page.getByText(/Resolved as approved/)).toBeVisible();
  await expect(revisions.getByRole("listitem").first()).toContainText("Model extraction");
});
