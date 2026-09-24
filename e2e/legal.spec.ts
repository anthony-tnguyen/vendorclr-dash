import { expect, test } from "@playwright/test";

/**
 * /terms and /privacy load for a signed-out visitor with real (interim,
 * pre-attorney-review) text: a named contracting party, a working contact
 * address, an effective date, and every commitment section filled in rather
 * than marked pending. They are reachable from the auth screens and the public
 * vendor portal, and sign-up states the agreement at the point of action.
 * Needs no credentials, so it runs in every build (live or sample data).
 */

for (const [path, heading, sections] of [
  [
    "/terms",
    "Terms of Service",
    ["Disclaimer of warranties", "Limitation of liability", "Governing law and disputes"],
  ],
  ["/privacy", "Privacy Notice", ["Data retention", "Your choices and rights", "Security"]],
] as const) {
  test(`${path} loads signed-out with complete, dated text`, async ({ page }) => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Effective September 24, 2026");
    for (const section of sections) {
      await expect(
        page.getByRole("heading", { level: 2, name: new RegExp(section) }),
      ).toBeVisible();
    }
    await expect(page.getByText("Anjeko Holdings LLC").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "support@vendorclr.com" }).first()).toBeVisible();
    // No section is left as an unfilled placeholder.
    await expect(page.getByText(/Pending legal\/product approval/)).toHaveCount(0);
    // Stayed on the page: a signed-out visitor is not bounced to /login.
    expect(new URL(page.url()).pathname).toBe(path);
  });
}

test("sign-up states the agreement at the point of action", async ({ page }) => {
  await page.goto("/signup", { waitUntil: "domcontentloaded" });
  const consent = page.getByText(/By creating an account, you agree to the/);
  await expect(consent).toBeVisible();
  await consent.getByRole("link", { name: "Terms of Service" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
});

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
