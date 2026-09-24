import { expect, test, type Page } from "@playwright/test";

import { capture, credentials, isLiveBuild, signIn } from "./helpers";

/**
 * Role-based browser coverage for the real access model:
 *
 *   signed out                     -> sign-in screen
 *   signed in, no activation       -> demo console
 *   activated company member       -> real dashboard
 *
 * The unauthenticated expectations always run. The signed-in journeys need real
 * accounts on the environment under test and skip themselves when those
 * credentials are absent - the access gate is never weakened to keep a test
 * green (see e2e/helpers.ts for the variable names).
 */

const viewports = [
  { name: "desktop" as const, width: 1440, height: 900 },
  { name: "mobile" as const, width: 390, height: 844 },
];

async function openNavigation(page: Page, viewport: "desktop" | "mobile") {
  if (viewport === "mobile") {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
  }
}

for (const viewport of viewports) {
  test.describe(`${viewport.name} role flows`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a signed-out visitor asking for the console gets the sign-in screen", async ({
      page,
    }, testInfo) => {
      const live = await isLiveBuild(page);
      test.skip(!live, "This build has no connection settings, so it runs as sample data.");

      await page.goto("/dashboard/vendors", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await expect(page).toHaveURL(/\/login/);
      // The page they asked for is remembered so sign-in can return them to it.
      await expect(page).toHaveURL(/redirect=/);
      await capture(page, testInfo, `${viewport.name}-signed-out`);
    });

    test("the front door sends a signed-out visitor to sign-in", async ({ page }) => {
      const live = await isLiveBuild(page);
      test.skip(!live, "This build has no connection settings, so it runs as sample data.");

      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    });

    test("the demo console explains itself to a signed-out visitor", async ({ page }, testInfo) => {
      await page.goto("/demo", { waitUntil: "domcontentloaded" });

      const live = await isLiveBuild(page);
      await page.goto("/demo", { waitUntil: "domcontentloaded" });

      if (live) {
        await expect(page.getByRole("heading", { name: "You're not signed in" })).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: "This is the demo console" })).toBeVisible();
      }
      await capture(page, testInfo, `${viewport.name}-demo-signed-out`);
    });

    test("a signed-in account with no activated workspace lands on the demo console", async ({
      page,
    }, testInfo) => {
      const account = credentials("DEMO");
      test.skip(!account, "No unactivated test account configured for this environment.");

      await signIn(page, account!);
      await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

      await expect(page).toHaveURL(/\/demo/);
      await expect(page.getByRole("heading", { name: "This is the demo console" })).toBeVisible();
      // Without exact, this also substring-matches the "Have an activation code?" region.
      await expect(page.getByLabel("Activation code", { exact: true })).toBeVisible();
      await capture(page, testInfo, `${viewport.name}-unactivated`);
    });

    test("an activated member reaches the real console and can search the roster", async ({
      page,
    }, testInfo) => {
      const account = credentials("MEMBER");
      test.skip(!account, "No activated member account configured for this environment.");

      await signIn(page, account!);
      await page.goto("/dashboard/vendors", { waitUntil: "domcontentloaded" });

      // Without exact, this also substring-matches the later "No vendors match this
      // search" heading once the empty-search assertion below runs.
      await expect(page.getByRole("heading", { name: "Vendors", exact: true })).toBeVisible();
      await openNavigation(page, viewport.name);
      // The page also has a "Legal" footer nav; only the sidebar is relevant here.
      await expect(page.getByRole("navigation", { name: "Dashboard sections" })).toBeVisible();

      const search = page.getByLabel("Search vendors");
      await search.fill("no matching vendor at all");
      await expect(page.getByText("No vendors match this search")).toBeVisible();
      await capture(page, testInfo, `${viewport.name}-member-empty-search`);

      await search.fill("");
      await page.getByRole("button", { name: "Show vendors needing action" }).click();
      await capture(page, testInfo, `${viewport.name}-member-filtered`);
    });

    test("a customer is told plainly that the admin console is not theirs", async ({
      page,
    }, testInfo) => {
      const account = credentials("MEMBER");
      test.skip(!account, "No activated member account configured for this environment.");

      await signIn(page, account!);
      await page.goto("/dashboard/admin", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("alert")).toBeVisible();
      await capture(page, testInfo, `${viewport.name}-permission-denied`);
    });

    test("staff can open the operations console", async ({ page }, testInfo) => {
      const account = credentials("STAFF");
      test.skip(!account, "No staff account configured for this environment.");

      await signIn(page, account!);
      await page.goto("/dashboard/admin", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Command center" })).toBeVisible();
      await capture(page, testInfo, `${viewport.name}-staff`);
    });

    test("a public upload link with a bad token says so", async ({ page }, testInfo) => {
      await page.goto("/vendor-upload/not-a-valid-token", { waitUntil: "domcontentloaded" });

      const error = page.getByRole("alert");
      await expect(error).toContainText("This link isn't working");
      await capture(page, testInfo, `${viewport.name}-public-upload-error`);
    });
  });
}
