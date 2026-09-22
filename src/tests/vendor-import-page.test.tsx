import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * CSV import UI through the real router: upload -> preview -> validate ->
 * confirm -> execute -> results. The server functions are mocked at the
 * module boundary (their logic is covered in vendor-import.test.ts and, for
 * import_vendor_row(), supabase/tests/vendor-import.test.ts); parsing and
 * the rejected-rows CSV are the real implementations.
 */

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
let memberRole = "project_engineer";

const validateVendorImportRows = vi.fn(async () => ({
  results: [
    {
      rowNumber: 1,
      status: "valid",
      errors: [],
      willCreateProject: true,
      willCreateVendor: true,
      willCreateAssignment: true,
    },
    {
      rowNumber: 2,
      status: "valid",
      errors: [],
      willCreateProject: false,
      willCreateVendor: false,
      willCreateAssignment: false,
    },
    {
      rowNumber: 3,
      status: "rejected",
      errors: [{ field: "trade", reason: '"Plumbing" is not a recognized trade.' }],
      willCreateProject: true,
      willCreateVendor: true,
      willCreateAssignment: true,
    },
  ],
}));
const executeVendorImport = vi.fn(async () => ({
  batchId: "batch-1",
  totalRows: 3,
  acceptedRows: 2,
  rejectedRows: 1,
  idempotentReplay: false,
  rowResults: [
    {
      rowNumber: 1,
      status: "accepted",
      projectCreated: true,
      vendorCreated: true,
      assignmentCreated: true,
      dispatch: { status: "failed", error: "provider down" },
    },
    {
      rowNumber: 2,
      status: "accepted",
      projectCreated: false,
      vendorCreated: false,
      assignmentCreated: false,
    },
    {
      rowNumber: 3,
      status: "rejected",
      errors: [{ field: "trade", reason: '"Plumbing" is not a recognized trade.' }],
    },
  ],
}));

vi.mock("@/workflows/vendorImports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workflows/vendorImports")>()),
  validateVendorImportRows: (...args: unknown[]) => validateVendorImportRows(...(args as [])),
  executeVendorImport: (...args: unknown[]) => executeVendorImport(...(args as [])),
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
                      role: memberRole,
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

const CSV = [
  "project_name,vendor_name,trade,contact_email,dispatch_request",
  "Harbor Tower,Cascade Steel,Structural Steel,ops@cascade.test,true",
  "Pier 9,Delta Electric,Electrical,,false",
  "Pier 9,Pipe Pros,Plumbing,,false",
].join("\n");

async function renderImport() {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-for-tests");
  const { getRouter } = await import("@/router");
  const router = getRouter();
  router.update({
    ...router.options,
    history: createMemoryHistory({ initialEntries: ["/dashboard/vendors/import"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  memberRole = "project_engineer";
});

describe("vendor CSV import page", () => {
  it("previews, validates, requires confirmation, executes once, and reports results", async () => {
    const user = userEvent.setup();
    const downloads: string[] = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    await renderImport();
    await user.upload(
      await screen.findByLabelText("CSV file"),
      new File([CSV], "vendors.csv", { type: "text/csv" }),
    );

    // Preview: every parsed row, nothing written yet.
    const preview = await screen.findByTestId("import-rows");
    expect(within(preview).getAllByRole("row")).toHaveLength(4);
    expect(within(preview).getByText("Pipe Pros")).toBeVisible();
    expect(executeVendorImport).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText(/Send an upload request/));
    await user.click(screen.getByRole("button", { name: "Validate 3 rows" }));

    // Validation: errors by row/column/reason and proposed actions per row.
    const errors = await screen.findByTestId("import-errors");
    expect(within(errors).getByRole("rowheader", { name: "3" })).toBeVisible();
    expect(within(errors).getByText("trade")).toBeVisible();
    expect(within(errors).getByText(/not a recognized trade/)).toBeVisible();
    const rows = within(screen.getByTestId("import-rows"));
    expect(rows.getByText("Create project")).toBeVisible();
    expect(rows.getByText("Match existing assignment")).toBeVisible();
    expect(rows.getByText("Send upload request")).toBeVisible();

    // Confirmation is required before any write.
    const importButton = screen.getByRole("button", { name: "Import 2 rows" });
    expect(importButton).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /reviewed the proposed actions/ }));
    await user.click(importButton);

    await waitFor(() => expect(executeVendorImport).toHaveBeenCalledTimes(1));
    const call = (
      executeVendorImport.mock.calls[0] as unknown as [
        {
          data: {
            companyId: string;
            idempotencyKey: string;
            dispatchRequests: boolean;
            rows: unknown[];
          };
        },
      ]
    )[0].data;
    expect(call.companyId).toBe(COMPANY_ID);
    expect(call.dispatchRequests).toBe(true);
    expect(call.rows).toHaveLength(3);
    expect(call.idempotencyKey).toMatch(/.+/);

    const results = within(await screen.findByTestId("import-results"));
    const value = (label: string) => results.getByText(label).nextElementSibling?.textContent;
    expect(value("Processed")).toBe("3");
    expect(value("Projects created")).toBe("1");
    expect(value("Projects matched")).toBe("1");
    expect(value("Assignments matched")).toBe("1");
    expect(value("Skipped (failed validation)")).toBe("1");
    expect(value("Request-send failures")).toBe("1");

    await user.click(screen.getByRole("button", { name: "Download rejected rows (1)" }));
    expect(downloads).toEqual(["vendorclr-import-rejected-rows.csv"]);
    clickSpy.mockRestore();
  });

  it("does not offer import to a read-only member", async () => {
    memberRole = "read_only";
    await renderImport();
    expect(await screen.findByText("Read-only access")).toBeVisible();
    expect(screen.queryByLabelText("CSV file")).not.toBeInTheDocument();
  });
});

describe("buildRejectedRowsCsv()", () => {
  it("returns the original columns plus the reasons, ready to fix and re-upload", async () => {
    const { buildRejectedRowsCsv } = await import("@/features/vendors/importResults");
    const { parseAllRows, parseCsv } = await import("@/workflows/vendorImports");
    const csv = buildRejectedRowsCsv(parseAllRows(CSV), [
      { rowNumber: 3, status: "rejected", errors: [{ field: "trade", reason: "bad trade" }] },
      { rowNumber: 1, status: "accepted" },
    ]);
    const [header, row, extra] = parseCsv(csv);
    expect(header![0]).toBe("row_number");
    expect(header!.at(-1)).toBe("errors");
    expect(row![0]).toBe("3");
    expect(row).toContain("Pipe Pros");
    expect(row!.at(-1)).toBe("trade: bad trade");
    expect(extra).toBeUndefined();
  });
});
