import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getRouter } from "@/router";

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

async function renderAdminRoute(initialEntry: string) {
  const { user, router } = await renderRoute(initialEntry);
  await user.click(screen.getByRole("button", { name: /preview as administrator/i }));
  return { router, user };
}

describe("authenticated-demo route behavior", () => {
  it.each([
    ["/login", "Sign in"],
    ["/signup", "Create an account"],
    ["/reset-password", "Reset password"],
  ])("renders %s with the auth demo disclaimer", async (path, heading) => {
    await renderRoute(path);

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(/does not authenticate anyone/i)).toBeInTheDocument();
  });

  it("signs up with a name, email and password only - no code of any kind", async () => {
    await renderRoute("/signup");

    expect(await screen.findByLabelText("Work email")).toBeInTheDocument();
    expect(screen.queryByLabelText(/invite code|activation code/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Company name")).not.toBeInTheDocument();
  });

  it("renders command-center metrics and a vendor needing attention", async () => {
    await renderRoute("/dashboard");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Command center" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Vendors tracked")).toBeInTheDocument();
    expect((await screen.findAllByText("Delgado Concrete Works")).length).toBeGreaterThan(0);
  });

  it("moves keyboard focus to dashboard content through the skip link", async () => {
    const { user } = await renderRoute("/dashboard/vendors");

    await screen.findByText("Corbett Structural Steel");
    await user.tab();

    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    expect(skipLink).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("renders the vendor roster with a compliance rail per vendor", async () => {
    await renderRoute("/dashboard/vendors");

    expect(await screen.findByText("Corbett Structural Steel")).toBeInTheDocument();
    expect(
      await screen.findByLabelText("Compliance rail for Corbett Structural Steel"),
    ).toBeInTheDocument();
  });

  it("filters the roster from the real vendors route", async () => {
    const { user } = await renderRoute("/dashboard/vendors");

    await screen.findByText("Corbett Structural Steel");
    await user.type(screen.getByLabelText("Search vendors"), "roofing");

    await waitFor(() =>
      expect(screen.queryByText("Corbett Structural Steel")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Beacon Roofing Systems")).toBeInTheDocument();
  });

  it("lets a coordinator isolate vendors that need compliance action", async () => {
    const { user } = await renderRoute("/dashboard/vendors");

    await screen.findByText("Northgate Mechanical");
    await user.click(screen.getByRole("button", { name: "Show vendors needing action" }));

    expect(screen.getByText("Delgado Concrete Works")).toBeInTheDocument();
    expect(screen.getByText("Rivera Electrical Contractors")).toBeInTheDocument();
    expect(screen.queryByText("Northgate Mechanical")).not.toBeInTheDocument();
    expect(screen.queryByText("Ironclad Fire Protection")).not.toBeInTheDocument();
  });

  it("renders the vendor detail limits and compliance rail", async () => {
    await renderRoute("/dashboard/vendors/vnd-1042");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Corbett Structural Steel" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Coverage limits")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Compliance rail for Corbett Structural Steel"),
    ).toBeInTheDocument();
  });

  it("renders the unknown-vendor empty state through the dynamic route", async () => {
    await renderRoute("/dashboard/vendors/vnd-does-not-exist");

    expect(await screen.findByText("Vendor not found")).toBeInTheDocument();
  });

  it("renders compliance tasks", async () => {
    await renderRoute("/dashboard/tasks");

    expect(await screen.findByText("Request replacement COI after lapse")).toBeInTheDocument();
  });

  it("does not claim an export was generated", async () => {
    const { user } = await renderRoute("/dashboard/reports");

    expect(await screen.findByText("Harbor Point Tower B")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /export csv/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/no file was generated/i);
  });

  it("does not persist requirement settings in demo mode", async () => {
    const { user } = await renderRoute("/dashboard/settings");

    await user.click(await screen.findByLabelText("Primary and non-contributory"));
    await user.click(screen.getByRole("button", { name: /save requirements/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/not saved to any database/i);
  });

  it("renders the help FAQ with answers behind each question", async () => {
    const { user } = await renderRoute("/dashboard/help");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Help & FAQ" }),
    ).toBeInTheDocument();

    await user.click(screen.getByText("Are renewal reminders automatic?"));
    expect(
      await screen.findByText(/30 days before an active vendor's policy expires/i),
    ).toBeInTheDocument();
  });
});

describe("administrator route behavior", () => {
  it.each([
    ["/dashboard/admin", "Admin overview"],
    ["/dashboard/admin/companies", "Companies"],
    ["/dashboard/admin/compliance", "Compliance queue"],
    ["/dashboard/admin/leads", "Leads"],
    ["/dashboard/admin/access", "Access management"],
    ["/dashboard/admin/activation", "Activation codes"],
  ])("denies %s for the customer demo role", async (path) => {
    await renderRoute(path);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /switch the demo role to administrator/i,
    );
  });

  it("renders the administrator overview after the demo role switch", async () => {
    await renderAdminRoute("/dashboard/admin");

    expect(await screen.findByText("Customer companies")).toBeInTheDocument();
  });

  it("renders companies after the demo role switch", async () => {
    await renderAdminRoute("/dashboard/admin/companies");

    expect(await screen.findByText("Halstead Builders")).toBeInTheDocument();
  });

  it("renders leads after the demo role switch", async () => {
    await renderAdminRoute("/dashboard/admin/leads");

    expect(await screen.findByText("Kestrel Design Build")).toBeInTheDocument();
  });

  it("keeps compliance-queue reviews demo-only", async () => {
    const { user } = await renderAdminRoute("/dashboard/admin/compliance");

    expect(await screen.findByText("Certificate of insurance")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Open review for Certificate of insurance from Delgado Concrete Works",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      /no review was recorded and no notification was sent/i,
    );
  });

  // Mutates the shared demo repository singleton (creates then withdraws a code
  // in its in-memory store). Kept last in this describe block since nothing
  // resets the repository between tests in this file - a test added after this
  // one would otherwise silently inherit the extra withdrawn code.
  it("creates and withdraws an activation code through the demo repository", async () => {
    const { user } = await renderAdminRoute("/dashboard/admin/activation");

    await screen.findByText("Halstead Builders");

    await user.click(screen.getByRole("button", { name: /create code/i }));
    await user.type(screen.getByLabelText("Company name"), "Cedar Ridge Contracting");
    await user.type(screen.getByLabelText("Customer email"), "owner@cedarridge.example");
    await user.click(screen.getByRole("button", { name: /^create code$/i }));

    expect(
      await screen.findByText(/code .+ created for owner@cedarridge\.example/i),
    ).toBeInTheDocument();
    expect(await screen.findByText("Cedar Ridge Contracting")).toBeInTheDocument();

    const row = screen.getByText("Cedar Ridge Contracting").closest("tr");
    if (!row) throw new Error("expected a table row for the new code");
    await user.click(within(row).getByRole("button", { name: /withdraw/i }));

    await waitFor(() =>
      expect(within(row).queryByRole("button", { name: /withdraw/i })).toBeNull(),
    );
    expect(within(row).getByText("revoked")).toBeInTheDocument();
  });
});
