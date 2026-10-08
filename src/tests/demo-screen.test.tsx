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

  it("renders the sample vendor roster read-only, dressed as the real console", async () => {
    const { user } = await renderRoute("/demo");

    const roster = await screen.findByRole("region", { name: /sample vendor roster/i });
    expect(roster).toBeInTheDocument();

    // The roster is the built-in sample list - the same names the demo console
    // uses everywhere else - rendered as the live overview's compliance matrix.
    expect(await within(roster).findByText("Corbett Structural Steel")).toBeInTheDocument();
    expect(await within(roster).findByText("Ironclad Fire Protection")).toBeInTheDocument();
    expect(within(roster).getAllByTestId("demo-vendor-row").length).toBeGreaterThan(5);
    // Every row shows the five-requirement compliance read, exposed as status
    // cells (five per vendor), so the preview mirrors the paid dashboard.
    expect(within(roster).getAllByRole("status").length).toBeGreaterThan(5);

    // The preview also carries the dashboard chrome: the inert customer sidebar
    // and the attention queue the real overview opens with.
    expect(screen.getByRole("heading", { level: 2, name: /needs attention/i })).toBeInTheDocument();

    // Read-only: no control can add a vendor, request a document or upload a
    // file. The toolbar's "Import vendors" is deliberately disabled, and the
    // activation code form is the only thing that ever reaches a backend.
    expect(
      screen.queryByRole("button", { name: /add vendor|request documents|upload/i }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /new vendor/i })).toBeNull();
    expect(screen.getByRole("button", { name: /import vendors/i })).toBeDisabled();
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
