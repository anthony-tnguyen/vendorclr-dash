import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createDemoRepository } from "@/data/demoRepository";
import { getRouter } from "@/router";

/**
 * The screen an account sees before a paid activation code has been entered.
 *
 * These run with no backend configured (the Vitest default), which is exactly
 * the state the demo screen has to survive: it renders its sample roster from
 * the in-memory demo repository rather than from the resolved repository, so
 * there is no database for it to be wrong about.
 */

async function renderRoute(initialEntry: string) {
  const router = getRouter();
  router.update({
    // Spread the existing options: update() replaces the whole option set, and
    // getRouter() supplies routeTree and the queryClient context that the root
    // route requires. Passing history alone drops them.
    ...router.options,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

describe("demo screen", () => {
  it("registers /demo as its own route", () => {
    const router = getRouter();
    expect(Object.keys(router.routesById)).toContain("/demo");
  });

  it("says plainly that what is on screen is sample data, not the account", async () => {
    await renderRoute("/demo");

    expect(
      await screen.findByRole("heading", { level: 2, name: "This is the demo console" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/built-in sample construction data, not your account/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing you do on this screen is saved/i)).toBeInTheDocument();
  });

  it("renders the sample vendor roster read-only, with the compliance rail on every row", async () => {
    const { user } = await renderRoute("/demo");

    const roster = await screen.findByRole("region", { name: /sample vendor roster/i });
    expect(roster).toBeInTheDocument();

    // The roster is the built-in sample list - the same names the demo console
    // uses everywhere else - and every row carries the five-slot rail.
    expect(await within(roster).findByText("Corbett Structural Steel")).toBeInTheDocument();
    expect(await within(roster).findByText("Ironclad Fire Protection")).toBeInTheDocument();
    expect(within(roster).getAllByTestId("demo-vendor-row").length).toBeGreaterThan(5);
    expect(
      (await within(roster).findAllByLabelText(/compliance matrix for/i)).length,
    ).toBeGreaterThan(5);

    // Read-only: the only controls on the page are the code form, sign out, the
    // skip link and the activation panel. No add-vendor, no document request,
    // no upload, nothing that could be mistaken for working.
    expect(
      screen.queryByRole("button", { name: /add vendor|request documents|upload/i }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /new vendor/i })).toBeNull();
    await user.tab();
  });

  it("refuses to take a code with no database connected instead of faking success", async () => {
    const { user } = await renderRoute("/demo");

    const panel = await screen.findByRole("region", { name: /have an activation code/i });
    expect(within(panel).getByText(/not connected to a database/i)).toBeInTheDocument();

    await user.type(within(panel).getByLabelText("Activation code"), "K7M2QP9XRD");
    await user.click(within(panel).getByRole("button", { name: "Activate my workspace" }));

    // Submitting is allowed (the same convention the auth forms use) but the
    // answer is a refusal, never a workspace it has not made.
    expect(
      await within(panel).findByText(/codes cannot be checked or redeemed here/i),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/is activated/i)).toBeNull();
  });

  it("the demo repository refuses to redeem rather than inventing a workspace", async () => {
    const repository = createDemoRepository();

    await expect(repository.redeemActivationCode("K7M2QP9XRD")).rejects.toThrow(
      /not checked or redeemed without a database/i,
    );
    await expect(repository.setCompanyActivation("cmp-1", "activated")).rejects.toThrow(
      /no company here to activate or close/i,
    );
  });

  it("offers a way out: sign out, and the sample roster never pretends to be the caller's", async () => {
    const { user } = await renderRoute("/demo");

    const header = await screen.findByRole("banner");
    expect(within(header).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(within(header).getByText("Demo console")).toBeInTheDocument();
    expect(screen.queryByText(/Halstead Builders is activated/i)).toBeNull();
  });
});
