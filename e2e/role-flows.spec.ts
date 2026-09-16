import { expect, test, type Page, type TestInfo } from "@playwright/test";

type Viewport = {
  name: "desktop" | "mobile";
  width: number;
  height: number;
};

const viewports: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

async function capture(page: Page, testInfo: TestInfo, state: string) {
  const path = testInfo.outputPath(`${state}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(state, { path, contentType: "image/png" });
}

for (const viewport of viewports) {
  test.describe(`${viewport.name} role flows`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("customer can triage the roster and receives an explicit admin denial", async ({
      page,
    }, testInfo) => {
      await page.goto("/dashboard/vendors");

      await expect(page.getByRole("heading", { name: "Vendors" })).toBeVisible();
      await page.getByRole("button", { name: "Show vendors needing action" }).click();
      await expect(page.getByText("Delgado Concrete Works")).toBeVisible();
      await expect(page.getByText("Northgate Mechanical")).not.toBeVisible();
      await capture(page, testInfo, `${viewport.name}-customer`);

      await page.goto("/dashboard/admin");
      const denial = page.getByRole("alert");
      await expect(denial).toContainText(/switch the demo role to administrator/i);
      await expect(denial).toBeFocused();
      await capture(page, testInfo, `${viewport.name}-permission-denied`);
    });

    test("administrator demo role can open the operations overview", async ({ page }, testInfo) => {
      await page.goto("/dashboard");

      if (viewport.name === "mobile") {
        await page.getByRole("button", { name: "Open navigation menu" }).click();
      }
      await page.getByRole("button", { name: /preview as administrator/i }).click();
      await page.getByRole("link", { name: "Review queue — Priority document decisions" }).click();

      await expect(page.getByRole("heading", { name: "Command center" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Review capacity" })).toBeVisible();
      await expect(page.getByText("Customer companies")).toBeVisible();
      await capture(page, testInfo, `${viewport.name}-administrator`);
    });

    test("public upload link communicates an invalid-link error", async ({ page }, testInfo) => {
      await page.goto("/vendor-upload/not-a-valid-token");

      const error = page.getByRole("alert");
      await expect(error).toContainText("This link isn't working");
      await expect(error).toBeFocused();
      await capture(page, testInfo, `${viewport.name}-public-upload-error`);
    });

    test("vendor search communicates its empty state", async ({ page }, testInfo) => {
      await page.goto("/dashboard/vendors");
      const search = page.getByLabel("Search vendors");
      await search.fill("no matching vendor");

      await expect(page.getByText("No vendors match this search")).toBeVisible();
      await capture(page, testInfo, `${viewport.name}-empty`);
    });
  });
}
