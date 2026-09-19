import type { Page } from "@playwright/test";
import type { TestInfo } from "@playwright/test";

/**
 * Shared helpers for the role-based browser suite.
 *
 * The suite runs against the built production bundle (see playwright.config.ts).
 * Whether that bundle has a database configured depends on the build
 * environment: `.env.production` supplies the browser connection settings for a
 * real deployment, and a build without them deliberately falls back to
 * sample-data mode. Both are legitimate, so the specs ask the running app which
 * one it is rather than assuming.
 */

/** True when the built bundle has browser connection settings, so auth is real. */
export async function isLiveBuild(page: Page): Promise<boolean> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const demoBanner = page.getByText("Demo mode — this form does not authenticate anyone");
  return (await demoBanner.count()) === 0;
}

export async function capture(page: Page, testInfo: TestInfo, state: string) {
  const path = testInfo.outputPath(`${state}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(state, { path, contentType: "image/png" });
}

/**
 * Credentials for the signed-in journeys. These are intentionally optional:
 * CI has no account on the production database, so the authenticated specs skip
 * themselves rather than inventing a session or weakening the access gate.
 *
 * Set in a GitHub environment to enable them:
 *   E2E_DEMO_EMAIL / E2E_DEMO_PASSWORD      - account with no activated workspace
 *   E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD  - member of an activated company
 *   E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD    - VendorClr staff account
 */
export function credentials(prefix: "DEMO" | "MEMBER" | "STAFF") {
  const email = process.env[`E2E_${prefix}_EMAIL`];
  const password = process.env[`E2E_${prefix}_PASSWORD`];
  return email && password ? { email, password } : null;
}

export async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Work email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
