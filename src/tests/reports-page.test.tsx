import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Reports page, live mode, through the real router: choose a report, see the
 * rows the server returned, export CSV through the server exporter, and get
 * a browser download. The server functions are mocked at the module
 * boundary; their own logic (membership check, CSV, audit_log write) is
 * covered in report-export.test.ts.
 */

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const getReportRows = vi.fn(async ({ data }: { data: { reportKind: string } }) => ({
  reportKind: data.reportKind,
  rows:
    data.reportKind === "expiring_30"
      ? [
          {
            vendorName: "Cascade Steel",
            policyType: "general_liability",
            expirationDate: "2026-10-05",
            projectName: "Harbor Tower",
            policyId: "pol-1",
          },
        ]
      : [
          {
            group: "Harbor Tower",
            assignments: 3,
            compliant: 1,
            nonCompliant: 1,
            notEvaluated: 1,
            compliantPct: 50,
            openDeficiencies: 2,
          },
        ],
}));
const exportReport = vi.fn(async () => ({
  filename: "Acme-expiring-30-days-2026-09-22.csv",
  csv: "Vendor,Policy type\r\nCascade Steel,general_liability",
  rowCount: 1,
}));

vi.mock("@/workflows/reportExports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workflows/reportExports")>()),
  getReportRows: (...args: unknown[]) => getReportRows(...(args as [never])),
  exportReport: (...args: unknown[]) => exportReport(...(args as [])),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: "u-1", email: "pm@acme.test" } } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: async () => ({ error: null }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({
              data:
                table === "company_members"
                  ? {
                      company_id: COMPANY_ID,
                      role: "read_only",
                      companies: { name: "Acme", activation_status: "activated" },
                    }
                  : null,
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async () => ({ data: false, error: null }),
  }),
}));

async function renderAt(path: string) {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-for-tests");
  const { getRouter } = await import("@/router");
  const router = getRouter();
  router.update({ ...router.options, history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe("reports page (live)", () => {
  it("shows real assignment-based rows for the default report", async () => {
    await renderAt("/dashboard/reports");

    const table = await screen.findByTestId("report-table");
    expect(within(table).getByRole("columnheader", { name: "Active assignments" })).toBeVisible();
    expect(within(table).getByRole("rowheader", { name: "Harbor Tower" })).toBeVisible();
    expect(getReportRows).toHaveBeenCalledWith({
      data: { companyId: COMPANY_ID, reportKind: "compliance_by_project" },
    });
  });

  it("switches report, exports CSV through the server, and downloads the file", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:report");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicks: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });

    await renderAt("/dashboard/reports");
    await screen.findByTestId("report-table");

    await user.selectOptions(screen.getByLabelText("Report"), "expiring_30");
    const table = await screen.findByTestId("report-table");
    await waitFor(() =>
      expect(within(table).getByRole("rowheader", { name: "Cascade Steel" })).toBeVisible(),
    );

    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => expect(clicks).toEqual(["Acme-expiring-30-days-2026-09-22.csv"]));
    expect(exportReport).toHaveBeenCalledWith({
      data: { companyId: COMPANY_ID, companyName: "Acme", reportKind: "expiring_30" },
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /recorded in your company's audit history/,
    );
    clickSpy.mockRestore();
  });

  it("surfaces a server export refusal instead of downloading anything", async () => {
    const user = userEvent.setup();
    exportReport.mockRejectedValueOnce(new Error("Not authorized to export this company's data."));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

    await renderAt("/dashboard/reports?report=open_deficiencies");
    await screen.findByTestId("report-table");
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not authorized");
    expect(clickSpy).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
