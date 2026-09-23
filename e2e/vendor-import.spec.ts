import { expect, test } from "@playwright/test";

import { capture, credentials, isLiveBuild, signIn } from "./helpers";

/**
 * upload CSV -> preview -> validate -> confirm -> execute
 * -> verify projects/vendors/assignments.
 *
 * Needs E2E_OWNER_* (owner of an activated company). Writes real rows with a
 * unique run suffix, so it is re-runnable, and does not dispatch any upload
 * request (dispatch stays off). The rows it creates are left in place; point
 * it at a test company.
 */

test("an owner imports projects and vendors from CSV", async ({ page }, testInfo) => {
  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");
  const account = credentials("OWNER");
  test.skip(!account, "No owner account configured for this environment.");

  const run = Date.now().toString(36);
  const project = `E2E Import Project ${run}`;
  const vendorA = `E2E Import Vendor A ${run}`;
  const vendorB = `E2E Import Vendor B ${run}`;
  const csv = [
    "project_name,vendor_name,trade,contact_email,risk_tier,contract_value,dispatch_request",
    `${project},${vendorA},Electrical,a-${run}@example.com,low,125000,false`,
    `${project},${vendorB},Concrete,,moderate,,false`,
    `${project},${vendorA},Electrical,,low,,false`,
    `,Missing Project Vendor ${run},Electrical,,,,false`,
  ].join("\n");

  await signIn(page, account!);
  await page.goto("/dashboard/vendors", { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Import CSV" }).click();
  await expect(page.getByRole("heading", { name: "Import vendors" })).toBeVisible();

  await page.getByLabel("CSV file").setInputFiles({
    name: `import-${run}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  const rows = page.getByTestId("import-rows");
  await expect(rows.getByRole("row")).toHaveCount(5);

  await page.getByRole("button", { name: "Validate 4 rows" }).click();
  const errors = page.getByTestId("import-errors");
  await expect(
    errors.getByRole("row", { name: /4 project_name Project name is required/ }),
  ).toBeVisible();
  // Row 3 repeats row 1's pair: predicted as a match, not a second create.
  await expect(rows.getByRole("row").nth(3)).toContainText("Match existing assignment");
  await expect(rows.getByRole("row").nth(1)).toContainText("Create project");
  await capture(page, testInfo, "import-validated");

  const importButton = page.getByRole("button", { name: "Import 3 rows" });
  await expect(importButton).toBeDisabled();
  await page.getByRole("checkbox", { name: /reviewed the proposed actions/ }).check();
  await importButton.click();

  const results = page.getByTestId("import-results");
  await expect(results).toBeVisible();
  const value = (label: string) =>
    results.locator("div", { has: page.getByText(label, { exact: true }) }).locator("dd");
  await expect(value("Processed")).toHaveText("4");
  await expect(value("Imported")).toHaveText("3");
  await expect(value("Projects created")).toHaveText("1");
  await expect(value("Vendors created")).toHaveText("2");
  await expect(value("Assignments created")).toHaveText("2");
  await expect(value("Assignments matched")).toHaveText("1");
  await expect(value("Skipped (failed validation)")).toHaveText("1");
  await capture(page, testInfo, "import-results");

  await page.getByRole("link", { name: "View projects" }).click();
  await expect(page.getByText(project)).toBeVisible();
  await page.getByText(project).click();
  // Scoped to the "Assigned vendors" list - the same page also has an
  // "Assign vendor" <select> with a hidden <option> for each vendor, which
  // an unscoped getByText(vendorName) also matches.
  const assignedVendors = page.locator("section", {
    has: page.getByRole("heading", { name: "Assigned vendors" }),
  });
  await expect(assignedVendors.getByText(vendorA)).toBeVisible();
  await expect(assignedVendors.getByText(vendorB)).toBeVisible();
});
