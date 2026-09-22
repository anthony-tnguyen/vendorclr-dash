import { expect, test } from "@playwright/test";
import { credentials, isLiveBuild, signIn } from "./helpers";

/**
 * owner opens Team -> invites teammate -> teammate opens link -> signs in ->
 * accepts -> teammate appears in the member list.
 *
 * Needs E2E_OWNER_* (owner of a real, activated company) and E2E_INVITEE_*
 * (a second account already signed up on the same environment) - see
 * e2e/helpers.ts. Skips itself, like every other credential-gated spec in
 * this suite, rather than weakening the access gate to stay green.
 *
 * Cleans up after itself (removes the invitee from the company at the end)
 * so the test is safely re-runnable: create_company_invitation() rejects
 * inviting an email that is already an active member.
 */
test("owner invites a teammate, who signs in and accepts", async ({ page }) => {
  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");

  const owner = credentials("OWNER");
  const invitee = credentials("INVITEE");
  test.skip(!owner || !invitee, "No owner/invitee test accounts configured for this environment.");

  await signIn(page, owner!);
  await page.goto("/dashboard/team", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();

  // Clean slate: if a previous run left the invitee as a member, remove them
  // first so create_company_invitation() doesn't reject a duplicate invite.
  const existingRow = page.getByRole("row", { name: new RegExp(invitee!.email) });
  if (await existingRow.count()) {
    page.once("dialog", (dialog) => void dialog.accept());
    await existingRow.getByRole("button", { name: "Remove" }).click();
    await expect(existingRow).not.toBeVisible();
  }

  await page.getByLabel("Email").fill(invitee!.email);
  await page.getByLabel("Role").selectOption("project_engineer");
  await page.getByRole("button", { name: "Send invitation" }).click();

  const linkLocator = page.getByRole("link", { name: /\/accept-invite\// });
  await expect(linkLocator).toBeVisible();
  const acceptUrl = await linkLocator.getAttribute("href");
  expect(acceptUrl).toBeTruthy();

  const acceptPath = new URL(acceptUrl!).pathname;

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, invitee!);
  await page.goto(acceptPath, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByRole("button", { name: "Go to your dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Go to your dashboard" }).click();

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, owner!);
  await page.goto("/dashboard/team", { waitUntil: "domcontentloaded" });

  const newRow = page.getByRole("row", { name: new RegExp(invitee!.email) });
  await expect(newRow).toBeVisible();

  // Clean up so the next run starts from the same state.
  page.once("dialog", (dialog) => void dialog.accept());
  await newRow.getByRole("button", { name: "Remove" }).click();
  await expect(newRow).not.toBeVisible();
});
