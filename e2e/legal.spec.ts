import { expect, test } from "@playwright/test";

/**
 * /terms and /privacy load for a signed-out visitor, show the
 * "Pending legal/product approval" marking instead of invented commitments,
 * and are reachable from the auth screens and the public vendor portal.
 * Needs no credentials, so it runs in every build (live or sample data).
 */

for (const [path, heading] of [
  ["/terms", "Terms of Service"],
  ["/privacy", "Privacy Notice"],
] as const) {
  test(`${path} loads signed-out and marks unapproved sections`, async ({ page }) => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Pending legal/product approval");
    await expect(
      page.getByText(/Pending legal\/product approval\. No commitment/).first(),
    ).toBeVisible();
    // Stayed on the page: a signed-out visitor is not bounced to /login.
    expect(new URL(page.url()).pathname).toBe(path);
  });
}

test("auth screens link to Terms and Privacy", async ({ page }) => {
  for (const authPath of ["/login", "/signup"]) {
    await page.goto(authPath, { waitUntil: "domcontentloaded" });
    const legal = page.getByRole("navigation", { name: "Legal" });
    await legal.getByRole("link", { name: "Terms" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();

    await page.goto(authPath, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("navigation", { name: "Legal" })
      .getByRole("link", { name: "Privacy" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Privacy Notice" })).toBeVisible();
  }
});

test("the vendor portal links to Terms and Privacy, even on a bad link", async ({ page }) => {
  await page.goto("/vendor-upload/not-a-valid-token", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert")).toContainText("This link isn't working");

  const legal = page.getByRole("navigation", { name: "Legal" });
  await legal.getByRole("link", { name: "Privacy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Notice" })).toBeVisible();

  await page
    .getByRole("navigation", { name: "Legal" })
    .getByRole("link", { name: "Terms" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
});
