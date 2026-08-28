import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The route components are exercised directly; router links are stubbed so the
// tests stay focused on page rendering rather than the generated route tree.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    activeOptions: _activeOptions,
    activeProps: _activeProps,
    params: _params,
    ...rest
  }: {
    to: string;
    children: ReactNode;
    activeOptions?: unknown;
    activeProps?: unknown;
    params?: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { App } from "@/app/App";
import { routes } from "@/app/router";
import { LoginPage, ResetPasswordPage, SignupPage } from "@/features/auth/AuthPages";
import { OverviewPage } from "@/features/overview/OverviewPage";
import { VendorsPage } from "@/features/vendors/VendorsPage";
import { VendorDetailPage } from "@/features/vendors/VendorDetailPage";
import { TasksPage } from "@/features/tasks/TasksPage";
import { ReportsPage } from "@/features/reports/ReportsPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { AdminOverviewPage } from "@/features/admin/AdminOverviewPage";
import { CompaniesPage } from "@/features/admin/CompaniesPage";
import { ComplianceQueuePage } from "@/features/admin/ComplianceQueuePage";
import { LeadsPage } from "@/features/admin/LeadsPage";
import { AccessPage } from "@/features/admin/AccessPage";

function renderPage(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App>{ui}</App>
    </QueryClientProvider>,
  );
}

describe("route map", () => {
  it("declares every required path", () => {
    expect(Object.values(routes)).toEqual([
      "/login",
      "/signup",
      "/reset-password",
      "/dashboard",
      "/dashboard/vendors",
      "/dashboard/vendors/$vendorId",
      "/dashboard/tasks",
      "/dashboard/reports",
      "/dashboard/settings",
      "/dashboard/admin",
      "/dashboard/admin/companies",
      "/dashboard/admin/compliance",
      "/dashboard/admin/leads",
      "/dashboard/admin/access",
    ]);
  });
});

describe("auth routes", () => {
  it.each([
    ["login", <LoginPage key="l" />, "Sign in"],
    ["signup", <SignupPage key="s" />, "Create an account"],
    ["reset-password", <ResetPasswordPage key="r" />, "Reset password"],
  ])("renders the %s page with a demo-mode disclaimer", (_name, ui, heading) => {
    renderPage(ui);
    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(/does not authenticate anyone/i)).toBeInTheDocument();
  });
});

describe("customer routes", () => {
  it("renders the overview with metrics and vendors needing attention", async () => {
    renderPage(<OverviewPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Program overview" })).toBeInTheDocument();
    expect(await screen.findByText("Vendors tracked")).toBeInTheDocument();
    expect(await screen.findByText("Delgado Concrete Works")).toBeInTheDocument();
  });

  it("renders the vendor roster with a compliance rail per vendor", async () => {
    renderPage(<VendorsPage />);
    expect(await screen.findByText("Corbett Structural Steel")).toBeInTheDocument();
    expect(
      await screen.findByLabelText("Compliance rail for Corbett Structural Steel"),
    ).toBeInTheDocument();
  });

  it("filters the roster from the search field", async () => {
    const user = userEvent.setup();
    renderPage(<VendorsPage />);
    await screen.findByText("Corbett Structural Steel");
    await user.type(screen.getByLabelText("Search vendors"), "roofing");
    await waitFor(() =>
      expect(screen.queryByText("Corbett Structural Steel")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Beacon Roofing Systems")).toBeInTheDocument();
  });

  it("renders the vendor detail with limits and the detail rail", async () => {
    renderPage(<VendorDetailPage vendorId="vnd-1042" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Corbett Structural Steel" })).toBeInTheDocument();
    expect(await screen.findByText("Coverage limits")).toBeInTheDocument();
    expect(screen.getByLabelText("Compliance rail for Corbett Structural Steel")).toBeInTheDocument();
  });

  it("shows an empty state for an unknown vendor id", async () => {
    renderPage(<VendorDetailPage vendorId="vnd-does-not-exist" />);
    expect(await screen.findByText("Vendor not found")).toBeInTheDocument();
  });

  it("renders tasks", async () => {
    renderPage(<TasksPage />);
    expect(await screen.findByText("Request replacement COI after lapse")).toBeInTheDocument();
  });

  it("renders reports and never claims an export happened", async () => {
    const user = userEvent.setup();
    renderPage(<ReportsPage />);
    expect(await screen.findByText("Harbor Point Tower B")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /export csv/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/no file was generated/i);
  });

  it("renders settings and does not persist on save", async () => {
    const user = userEvent.setup();
    renderPage(<SettingsPage />);
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/not saved to any backend/i);
  });
});

describe("administrator routes", () => {
  const adminPages: [string, ReactNode][] = [
    ["admin overview", <AdminOverviewPage key="a" />],
    ["companies", <CompaniesPage key="b" />],
    ["compliance queue", <ComplianceQueuePage key="c" />],
    ["leads", <LeadsPage key="d" />],
    ["access", <AccessPage key="e" />],
  ];

  it.each(adminPages)("denies %s for the customer demo role", (_name, ui) => {
    renderPage(ui);
    expect(screen.getByRole("alert")).toHaveTextContent(/Switch the demo role to Administrator/i);
  });

  it("renders admin content after switching the demo role", async () => {
    const user = userEvent.setup();
    renderPage(<CompaniesPage />);
    await user.click(screen.getByRole("button", { name: /preview as administrator/i }));
    expect(await screen.findByText("Halstead Builders")).toBeInTheDocument();
  });

  it("renders the compliance queue for the administrator role", async () => {
    const user = userEvent.setup();
    renderPage(<ComplianceQueuePage />);
    await user.click(screen.getByRole("button", { name: /preview as administrator/i }));
    expect(await screen.findByText("Certificate of insurance")).toBeInTheDocument();
  });

  it("renders leads and access for the administrator role", async () => {
    const user = userEvent.setup();
    renderPage(<LeadsPage />);
    await user.click(screen.getByRole("button", { name: /preview as administrator/i }));
    expect(await screen.findByText("Kestrel Design Build")).toBeInTheDocument();
  });

  it("does not claim an invitation was sent from access management", async () => {
    const user = userEvent.setup();
    renderPage(<AccessPage />);
    await user.click(screen.getByRole("button", { name: /preview as administrator/i }));
    await screen.findByText("Rosa Sandoval");
    await user.click(screen.getByRole("button", { name: /invite teammate/i }));
    expect(
      await screen.findByText(/no invitation was created or emailed/i),
    ).toBeInTheDocument();
  });
});
