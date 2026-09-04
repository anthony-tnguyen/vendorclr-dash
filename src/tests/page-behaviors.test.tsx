import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("renders command-center metrics and a vendor needing attention", async () => {
    await renderRoute("/dashboard");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Command center" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Vendors tracked")).toBeInTheDocument();
    expect((await screen.findAllByText("Delgado Concrete Works")).length).toBeGreaterThan(0);
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

  it("does not persist settings", async () => {
    const { user } = await renderRoute("/dashboard/settings");

    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/not saved to any backend/i);
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

  it("keeps access invitations demo-only", async () => {
    const { user } = await renderAdminRoute("/dashboard/admin/access");

    await screen.findByText("Rosa Sandoval");
    await user.click(screen.getByRole("button", { name: /invite teammate/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /no invitation was created or emailed/i,
    );
  });
});
