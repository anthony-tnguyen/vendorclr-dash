import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { capture, credentials, isLiveBuild, signIn } from "./helpers";

/**
 * open Reports -> choose report -> verify real data -> export CSV
 * -> download succeeds -> audit event recorded.
 *
 * Needs E2E_MEMBER_* (an activated company member). The audit-event check
 * reads audit_log through PostgREST and additionally needs
 * E2E_VERIFY_SUPABASE_URL + E2E_VERIFY_SERVICE_ROLE_KEY for the SAME
 * environment; without them the spec says so in its annotations instead of
 * claiming the audit row was checked. The server writes that row in the same
 * request that returns the CSV (exportReportHandler), and the unit suite
 * (src/tests/report-export.test.ts) asserts it.
 */

async function auditRowsSince(sinceIso: string, filename: string) {
  const url = process.env["E2E_VERIFY_SUPABASE_URL"];
  const key = process.env["E2E_VERIFY_SERVICE_ROLE_KEY"];
  if (!url || !key) return null;
  const response = await fetch(
    `${url}/rest/v1/audit_log?action=eq.report_exported&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,detail`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  expect(response.ok).toBe(true);
  const rows = (await response.json()) as Array<{ detail: { filename?: string } }>;
  return rows.filter((r) => r.detail?.filename === filename);
}

test("a member exports a report as CSV", async ({ page }, testInfo) => {
  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");
  const account = credentials("MEMBER");
  test.skip(!account, "No activated member account configured for this environment.");

  await signIn(page, account!);
  await page.goto("/dashboard/reports?report=expiring_90", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByLabel("Report")).toHaveValue("expiring_90");

  await page.getByLabel("Report").selectOption("compliance_by_project");
  const table = page.getByTestId("report-table");
  const empty = page.getByText(/^Nothing in "Compliance by project"$/);
  await expect(table.or(empty)).toBeVisible();
  const hasRows = await table.isVisible();
  if (hasRows) {
    await expect(table.getByRole("columnheader", { name: "Active assignments" })).toBeVisible();
  }
  await capture(page, testInfo, "report-compliance-by-project");

  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;

  const filename = download.suggestedFilename();
  expect(filename).toMatch(/^[\w-]+-compliance-by-project-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv.split(/\r?\n/)[0]).toBe(
    "Project,Active assignments,Compliant,With open deficiencies,Not yet evaluated,Compliant %,Open deficiencies",
  );
  if (hasRows) expect(csv.split(/\r?\n/).length).toBeGreaterThan(1);
  await expect(page.getByRole("status")).toContainText(filename);

  const audit = await auditRowsSince(startedAt, filename);
  if (audit === null) {
    testInfo.annotations.push({
      type: "not-verified",
      description:
        "audit_log row not checked: set E2E_VERIFY_SUPABASE_URL and E2E_VERIFY_SERVICE_ROLE_KEY",
    });
  } else {
    expect(audit).toHaveLength(1);
  }
});
