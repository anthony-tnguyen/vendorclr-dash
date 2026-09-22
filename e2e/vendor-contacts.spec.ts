import { expect, test } from "@playwright/test";

import { capture, credentials, isLiveBuild, signIn } from "./helpers";

/**
 * open vendor -> add broker -> request documents -> choose broker +
 * operational contact -> suppressed recipient excluded -> send ->
 * communication history shows the request.
 *
 * This journey really sends a document request through the environment's
 * configured email provider, so beyond the usual member credentials it is
 * opt-in: set E2E_REQUEST_JOURNEY=1 against a staging environment. Every
 * address it creates is on Resend's sandbox domain (delivered+…@resend.dev),
 * which accepts and reports delivery without reaching a real inbox. Optional
 * E2E_VENDOR_ID pins the vendor; otherwise the first vendor on the roster is
 * used. The contacts it adds are unlinked again at the end.
 */

const runId = Date.now().toString(36);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const broker = {
  name: `E2E Broker ${runId}`,
  organization: "E2E Brokerage",
  email: `delivered+broker-${runId}@resend.dev`,
};
const blocked = {
  name: `E2E Suppressed ${runId}`,
  email: `delivered+suppressed-${runId}@resend.dev`,
};
const operational = {
  name: `E2E Operational ${runId}`,
  email: `delivered+ops-${runId}@resend.dev`,
};

test("a member sends a document request to a broker and the operational contact, excluding a suppressed address", async ({
  page,
}, testInfo) => {
  const account = credentials("MEMBER");
  test.skip(!account, "No activated member account configured for this environment.");
  test.skip(
    process.env["E2E_REQUEST_JOURNEY"] !== "1",
    "Sends a real request through the email provider; opt in with E2E_REQUEST_JOURNEY=1 on staging.",
  );
  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");

  await signIn(page, account!);
  await expect(page).toHaveURL(/\/dashboard/);

  // --- open vendor -------------------------------------------------------
  const vendorId = process.env["E2E_VENDOR_ID"];
  if (vendorId) {
    await page.goto(`/dashboard/vendors/${vendorId}`, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto("/dashboard/vendors", { waitUntil: "domcontentloaded" });
    await page.locator('a[href^="/dashboard/vendors/"]').first().click();
  }
  const contacts = page.getByRole("region", { name: "Contacts" });
  await expect(contacts).toBeVisible();

  async function addContact(
    person: { name: string; email: string; organization?: string },
    role: string,
  ) {
    await contacts.getByRole("button", { name: "Add contact" }).click();
    const form = contacts.getByRole("form", { name: "Add contact" });
    await form.getByLabel("Name").fill(person.name);
    if (person.organization) await form.getByLabel("Agency / company").fill(person.organization);
    await form.getByLabel("Email").fill(person.email);
    await form.getByLabel("Role").selectOption(role);
    await form.getByRole("button", { name: "Save contact" }).click();
    await expect(contacts.getByRole("listitem", { name: new RegExp(person.name) })).toBeVisible();
  }

  // --- add broker (+ an operational contact if the vendor has none) -------
  await addContact(broker, "broker");
  const hasOperational =
    (await contacts.getByRole("listitem", { name: /, Operational$/ }).count()) > 0;
  if (!hasOperational) await addContact(operational, "operational");

  // A third contact, marked do-not-email, stands in for a bounced address.
  await addContact(blocked, "secondary");
  const blockedRow = contacts.getByRole("listitem", { name: new RegExp(blocked.name) });
  await blockedRow.getByRole("button", { name: "Mark do-not-email" }).click();
  await expect(blockedRow.getByText("Do not email")).toBeVisible();
  await capture(page, testInfo, "contacts-with-suppression");

  // --- request documents: broker + operational, suppressed excluded ------
  const comms = page.getByRole("region", { name: /Document requests/ });
  await comms.getByRole("button", { name: "Request documents" }).click();
  const composer = comms.getByRole("form", { name: "Request documents" });

  await composer.getByRole("checkbox", { name: new RegExp(broker.name) }).check();
  const operationalBoxes = composer.getByRole("checkbox", { name: /Operational/ });
  await expect(operationalBoxes.first()).toBeChecked();
  await expect(composer.getByRole("checkbox", { name: new RegExp(blocked.name) })).toBeDisabled();

  const preview = composer.getByTestId("request-recipient-preview");
  await expect(preview).toContainText(broker.email);
  await expect(preview).toContainText("Operational");
  await expect(preview).not.toContainText(blocked.email);
  await expect(composer.getByTestId("request-excluded-preview")).toContainText(blocked.email);
  await capture(page, testInfo, "request-preview");

  // --- send --------------------------------------------------------------
  await composer.getByRole("button", { name: /^Send to \d+ recipients?$/ }).click();
  await expect(comms.getByText("Request created.")).toBeVisible();
  await expect(comms.getByText(new RegExp(`${escape(broker.email)}.*Sent`))).toBeVisible();

  // --- history shows the request ----------------------------------------
  await comms.getByRole("button", { name: "Done" }).click();
  const latest = comms.getByTestId("communication-entry").first();
  await expect(latest).toContainText(broker.email);
  await expect(latest).toContainText("Broker");
  await capture(page, testInfo, "communication-history");

  // --- tidy up: unlink what this run added (history rows remain) --------
  for (const person of [broker, blocked, ...(hasOperational ? [] : [operational])]) {
    const row = contacts.getByRole("listitem", { name: new RegExp(person.name) });
    await row.getByRole("button", { name: /^Unlink/ }).click();
    await expect(row).toHaveCount(0);
  }
});
