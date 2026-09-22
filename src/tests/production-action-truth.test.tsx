import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccessPage } from "@/features/admin/AccessPage";
import { ReportsPage } from "@/features/reports/ReportsPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { VendorForm } from "@/features/vendors/VendorForm";

const repository = {
  listAccessGrants: vi.fn().mockResolvedValue([]),
  listReportRows: vi.fn().mockResolvedValue([]),
  createVendor: vi.fn(),
};

vi.mock("@/app/App", () => ({
  useSession: () => ({
    mode: "live",
    status: "authenticated",
    role: "admin",
    setRole: vi.fn(),
    canSwitchRole: false,
    personName: "Live user",
    companyName: "Live company",
    userId: "user-1",
    signOut: vi.fn(),
  }),
}));

vi.mock("@/components/shell/AppShell", () => ({
  AppShell: ({
    title,
    subtitle,
    actions,
    children,
  }: PropsWithChildren<{
    title: string;
    subtitle?: string;
    actions?: ReactNode;
  }>) => (
    <main>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {actions}
      {children}
    </main>
  ),
}));

vi.mock("@/data/repository", () => ({
  getRepository: () => repository,
  isBackendConfigured: () => true,
}));

function renderWithQueryClient(element: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function main() {
  return within(screen.getByRole("main"));
}

afterEach(() => {
  repository.listAccessGrants.mockReset().mockResolvedValue([]);
  repository.listReportRows.mockReset().mockResolvedValue([]);
  repository.createVendor.mockReset();
});

describe("production action truthfulness", () => {
  it("does not present demo-only settings controls as a production save", async () => {
    renderWithQueryClient(<SettingsPage />);

    // No company on the mocked live session: the page says so rather than
    // offering controls that would save nowhere.
    expect(await main().findByRole("alert")).toHaveTextContent(/not linked to a company/i);
    expect(main().queryByRole("button", { name: /save requirements/i })).not.toBeInTheDocument();
    expect(main().queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it("offers the real CSV export in production, and only once there is a company to export", async () => {
    renderWithQueryClient(<ReportsPage />);

    // The mocked live session has no company: the page says so, and the
    // server-backed export stays disabled rather than pretending to work.
    expect(await main().findByText("No company workspace")).toBeInTheDocument();
    expect(main().getByRole("button", { name: "Export CSV" })).toBeDisabled();
    expect(main().queryByText(/demo/i)).not.toBeInTheDocument();
    expect(main().queryByText(/not available/i)).not.toBeInTheDocument();
  });

  it("does not present a broken teammate-invite control on the legacy access page", async () => {
    renderWithQueryClient(<AccessPage />);

    expect(await main().findByText("No access grants")).toBeInTheDocument();
    expect(main().queryByRole("button", { name: /invit/i })).not.toBeInTheDocument();
    expect(main().queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it("labels a live-backed vendor create form without demo language", () => {
    renderWithQueryClient(<VendorForm />);

    const form = screen.getByRole("form", { name: "Add vendor" });
    expect(within(form).getByRole("button", { name: "Add vendor" })).toBeEnabled();
    expect(within(form).queryByText(/demo/i)).not.toBeInTheDocument();
  });
});
