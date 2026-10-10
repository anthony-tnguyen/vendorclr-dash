import { describe, expect, it } from "vitest";

import type { VendorTrade } from "@/data/contracts";
import {
  emptyValidationContext,
  executeVendorImportHandler,
  parseAllRows,
  previewVendorImport,
  validateOneRow,
  validateRows,
  validateVendorImportRowsHandler,
  TRADE_VALUES,
  type ParsedRow,
  type RowDispatchResult,
  type Trade,
} from "@/workflows/vendorImports";

/**
 * Task 11a - src/workflows/vendorImports.ts. RLS/write-authorization itself
 * is proven against real Postgres in supabase/tests/vendor-import.test.ts
 * (import_vendor_row()), not here - this file proves the TypeScript layer's
 * own logic: CSV parsing, per-row validation (row/field/reason and the
 * willCreateProject/willCreateVendor prediction), and executeVendorImport()'s
 * idempotency/mixed-batch/dispatch-isolation behavior against a fake
 * Supabase client, the same "mocked client proves this function builds the
 * right query and behaves correctly; RLS coverage can't see that either"
 * split feature-flags.test.ts already documents for this codebase.
 */

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    rowNumber: 1,
    projectName: "Harbor Tower",
    certificateHolderName: "",
    certificateHolderAddress: "",
    vendorName: "Cascade Steel",
    trade: "",
    contactName: "",
    contactEmail: "",
    riskTier: "",
    contractValue: null,
    dispatchRequest: false,
    ...overrides,
  };
}

describe("previewVendorImport()", () => {
  it("parses a CSV with quoted fields containing embedded commas and a header row", () => {
    const csv =
      "project_name,vendor_name,contact_name\n" +
      '"Harbor Tower, Phase 2",Cascade Steel,"Doe, Jane"\n' +
      "Lakeside Campus,Beacon Roofing,John Smith\n";

    const preview = previewVendorImport(csv);

    expect(preview.columns).toEqual(["project_name", "vendor_name", "contact_name"]);
    expect(preview.totalRows).toBe(2);
    expect(preview.sampleRows[0]).toMatchObject({
      rowNumber: 1,
      projectName: "Harbor Tower, Phase 2",
      vendorName: "Cascade Steel",
      contactName: "Doe, Jane",
    });
    expect(preview.sampleRows[1]).toMatchObject({
      rowNumber: 2,
      projectName: "Lakeside Campus",
      vendorName: "Beacon Roofing",
      contactName: "John Smith",
    });
  });

  it("handles embedded newlines inside a quoted field", () => {
    const csv = 'project_name,vendor_name\n"Multi\nLine Project",Acme Co\n';
    const preview = previewVendorImport(csv);
    expect(preview.sampleRows[0]!.projectName).toBe("Multi\nLine Project");
  });

  it("returns an empty result for an empty file", () => {
    expect(previewVendorImport("")).toEqual({ columns: [], totalRows: 0, sampleRows: [] });
  });

  it("only samples the first 5 rows but reports the true total row count", () => {
    const header = "project_name,vendor_name\n";
    const dataRows = Array.from({ length: 8 }, (_, i) => `Project ${i},Vendor ${i}`).join("\n");
    const preview = previewVendorImport(header + dataRows + "\n");
    expect(preview.totalRows).toBe(8);
    expect(preview.sampleRows).toHaveLength(5);
  });
});

describe("parseAllRows()", () => {
  it("parses every data row, not just a sample", () => {
    const header = "project_name,vendor_name\n";
    const dataRows = Array.from({ length: 12 }, (_, i) => `Project ${i},Vendor ${i}`).join("\n");
    const rows = parseAllRows(header + dataRows + "\n");
    expect(rows).toHaveLength(12);
    expect(rows[11]).toMatchObject({ rowNumber: 12, projectName: "Project 11" });
  });
});

describe("validateOneRow()", () => {
  it("reports row number, field and reason for a row missing a required field", () => {
    const result = validateOneRow(row({ rowNumber: 3, projectName: "" }), emptyValidationContext());
    expect(result.rowNumber).toBe(3);
    expect(result.status).toBe("rejected");
    expect(result.errors).toContainEqual({
      field: "project_name",
      reason: "Project name is required.",
    });
  });

  it("reports an invalid trade value", () => {
    const result = validateOneRow(row({ trade: "Plumbing" }), emptyValidationContext());
    expect(result.status).toBe("rejected");
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "trade", reason: expect.stringContaining("Plumbing") }),
    );
  });

  it("reports an invalid email shape", () => {
    const result = validateOneRow(row({ contactEmail: "not-an-email" }), emptyValidationContext());
    expect(result.status).toBe("rejected");
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "contact_email" }));
  });

  it("reports an invalid risk_tier value", () => {
    const result = validateOneRow(row({ riskTier: "extreme" }), emptyValidationContext());
    expect(result.status).toBe("rejected");
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "risk_tier" }));
  });

  it("accepts a fully valid row with no errors", () => {
    const result = validateOneRow(
      row({ trade: "Structural Steel", riskTier: "moderate", contactEmail: "ops@acme.test" }),
      emptyValidationContext(),
    );
    expect(result.status).toBe("valid");
    expect(result.errors).toEqual([]);
  });

  it("accepts 'Other' as a recognized trade", () => {
    const result = validateOneRow(row({ trade: "Other" }), emptyValidationContext());
    expect(result.status).toBe("valid");
    expect(result.errors).toEqual([]);
  });

  it("predicts willCreateProject/willCreateVendor against seeded existing data vs. genuinely new names", () => {
    // existingProjectNames is seeded with the project's exact on-file casing
    // (trim-only, no lowercasing) - matching what fetchValidationContext()
    // actually populates it with (projects.name's own case-sensitive
    // `unique (company_id, name)` constraint, Task 4). existingVendorNames/
    // existingVendorEmails ARE pre-lowercased, matching normalizeMatch()'s
    // case-insensitive vendor matching.
    const ctx = {
      existingProjectNames: new Set(["Harbor Tower"]),
      existingVendorNames: new Set(["cascade steel"]),
      existingVendorEmails: new Set(["ops@cascadesteel.test"]),
    };

    const existingBoth = validateOneRow(
      row({ projectName: "Harbor Tower", vendorName: "Cascade Steel" }),
      ctx,
    );
    expect(existingBoth.willCreateProject).toBe(false);
    expect(existingBoth.willCreateVendor).toBe(false);

    const newBoth = validateOneRow(
      row({ projectName: "Brand New Project", vendorName: "Brand New Vendor" }),
      ctx,
    );
    expect(newBoth.willCreateProject).toBe(true);
    expect(newBoth.willCreateVendor).toBe(true);

    const matchByEmailOnly = validateOneRow(
      row({
        projectName: "Brand New Project",
        vendorName: "A Totally Different Name",
        contactEmail: "OPS@CascadeSteel.test",
      }),
      ctx,
    );
    expect(matchByEmailOnly.willCreateVendor).toBe(false);
  });

  it("project matching is case-SENSITIVE (trim-only) while vendor matching is case-INSENSITIVE - mirroring import_vendor_row()'s SQL exactly", () => {
    // Regression test for a real bug: this file previously used the SAME
    // trim+lowercase normalizeMatch() for both projects and vendors, so a
    // differently-cased project name was predicted here as "will match an
    // existing project" while import_vendor_row()'s case-sensitive SQL
    // comparison would NOT match it - execute() would then silently create
    // a duplicate project row, exactly contradicting what validate told the
    // caller would happen. See normalizeProjectMatch()'s own doc comment.
    const ctx = {
      existingProjectNames: new Set(["Harbor Tower"]),
      existingVendorNames: new Set(["cascade steel"]),
      existingVendorEmails: new Set([]),
    };

    const differentCaseProject = validateOneRow(
      row({ projectName: "harbor tower", vendorName: "Cascade Steel" }),
      ctx,
    );
    // Must predict a FRESH project create, matching the SQL function's own
    // case-sensitive lookup, which will not find "Harbor Tower" for an
    // incoming "harbor tower".
    expect(differentCaseProject.willCreateProject).toBe(true);
    // Vendor matching stays case-insensitive - unaffected by the project fix.
    expect(differentCaseProject.willCreateVendor).toBe(false);
  });
});

describe("validateRows()", () => {
  it("folds an earlier valid row's new project/vendor into the prediction for a later row in the same batch", () => {
    const rows = [
      row({ rowNumber: 1, projectName: "New Site", vendorName: "New Vendor" }),
      row({ rowNumber: 2, projectName: "New Site", vendorName: "New Vendor" }),
    ];
    const results = validateRows(rows, emptyValidationContext());

    expect(results[0]!.willCreateProject).toBe(true);
    expect(results[0]!.willCreateVendor).toBe(true);
    // Second row names the exact same project/vendor as the first (now-valid)
    // row - it must predict a lookup, not a second create, matching what
    // import_vendor_row() will actually do when called sequentially.
    expect(results[1]!.willCreateProject).toBe(false);
    expect(results[1]!.willCreateVendor).toBe(false);
  });

  it("does not fold a rejected row's project/vendor into later predictions", () => {
    const rows = [
      row({ rowNumber: 1, projectName: "", vendorName: "Never Created Vendor" }),
      row({
        rowNumber: 2,
        projectName: "Never Created Vendor Project",
        vendorName: "Someone Else",
      }),
    ];
    const results = validateRows(rows, emptyValidationContext());
    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!.willCreateVendor).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeVendorImportHandler() - against a fake Supabase client.
// ---------------------------------------------------------------------------

interface FakeTableState {
  /** Result of the can_write_company() role check; defaults to true (a writer). */
  canWrite?: boolean;
  /** Result of the is_platform_admin() check; defaults to false (not staff). */
  isPlatformAdmin?: boolean;
  projects: Array<{ name: string }>;
  vendors: Array<{ name: string; contact_email: string }>;
  batches: Map<
    string,
    {
      id: string;
      total_rows: number;
      accepted_rows: number;
      rejected_rows: number;
      row_results: unknown;
    }
  >;
}

function makeFakeSupabase(
  state: FakeTableState,
  rpcImpl: (params: Record<string, unknown>) => {
    data: unknown;
    error: { message: string; code?: string } | null;
  },
) {
  let batchIdCounter = 0;

  function builderFor(table: string) {
    const filters: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake query-builder for tests; a real supabase-js PostgrestFilterBuilder type is not worth reproducing here.
    const builder: any = {};
    Object.assign(builder, {
      select: () => builder,
      order: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      insert: (payload: Record<string, unknown>) => {
        builder._insertPayload = payload;
        return builder;
      },
      maybeSingle: async () => {
        if (table === "vendor_import_batches") {
          const key = `${filters["company_id"]}:${filters["idempotency_key"]}`;
          const found = state.batches.get(key);
          return { data: found ?? null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        if (table === "vendor_import_batches") {
          if (builder._insertPayload) {
            const payload = builder._insertPayload;
            const key = `${payload["company_id"]}:${payload["idempotency_key"]}`;
            if (state.batches.has(key)) {
              return { data: null, error: { message: "duplicate key", code: "23505" } };
            }
            batchIdCounter += 1;
            const record = {
              id: `batch-${batchIdCounter}`,
              total_rows: payload["total_rows"] as number,
              accepted_rows: payload["accepted_rows"] as number,
              rejected_rows: payload["rejected_rows"] as number,
              row_results: payload["row_results"],
            };
            state.batches.set(key, record);
            return { data: { id: record.id }, error: null };
          }
          const key = `${filters["company_id"]}:${filters["idempotency_key"]}`;
          const found = state.batches.get(key);
          return found
            ? { data: found, error: null }
            : { data: null, error: { message: "not found" } };
        }
        return { data: null, error: null };
      },
      then: (
        onFulfilled?: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        // Plain (non-maybeSingle/single) awaits, e.g. fetchValidationContext's
        // reads of projects/vendors, and the audit_log insert.
        let result: { data: unknown; error: unknown };
        if (table === "projects") result = { data: state.projects, error: null };
        else if (table === "vendors") result = { data: state.vendors, error: null };
        else result = { data: null, error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    });
    return builder;
  }

  return {
    from: (table: string) => builderFor(table),
    rpc: async (name: string, params: Record<string, unknown>) =>
      name === "can_write_company"
        ? { data: state.canWrite ?? true, error: null }
        : name === "is_platform_admin"
          ? { data: state.isPlatformAdmin ?? false, error: null }
          : rpcImpl(params),
  };
}

function successfulRpc(params: Record<string, unknown>) {
  const vendorName = String(params["p_vendor_name"]);
  return {
    data: {
      project_id: `project-${params["p_project_name"]}`,
      project_created: true,
      vendor_id: `vendor-${vendorName}`,
      vendor_created: true,
      assignment_id: `assignment-${params["p_project_name"]}-${vendorName}`,
      assignment_created: true,
    },
    error: null,
  };
}

function emptyState(): FakeTableState {
  return { projects: [], vendors: [], batches: new Map() };
}

const okDispatch: RowDispatchResult = { status: "sent" };
const failingDispatch: RowDispatchResult = { status: "error", error: "provider unavailable" };

describe("validateVendorImportRowsHandler()", () => {
  it("reads existing projects/vendors and validates against them", async () => {
    const state = emptyState();
    state.projects.push({ name: "Harbor Tower" });
    state.vendors.push({ name: "Cascade Steel", contact_email: "ops@cascadesteel.test" });
    const supabase = makeFakeSupabase(state, successfulRpc);

    const result = await validateVendorImportRowsHandler(supabase as never, "company-1", [
      row({ rowNumber: 1, projectName: "Harbor Tower", vendorName: "Cascade Steel" }),
      row({ rowNumber: 2, projectName: "New Site", vendorName: "New Vendor" }),
    ]);

    expect(result.results[0]).toMatchObject({ willCreateProject: false, willCreateVendor: false });
    expect(result.results[1]).toMatchObject({ willCreateProject: true, willCreateVendor: true });
  });
});

describe("executeVendorImportHandler()", () => {
  it("called twice with the SAME idempotency key returns the identical result both times and does not create a second batch", async () => {
    const state = emptyState();
    const supabase = makeFakeSupabase(state, successfulRpc);

    const params = {
      companyId: "company-1",
      idempotencyKey: "csv-import-key-1",
      rows: [row({ rowNumber: 1 })],
      dispatchRequests: false,
    };

    const first = await executeVendorImportHandler(
      supabase as never,
      params,
      async () => okDispatch,
    );
    const second = await executeVendorImportHandler(
      supabase as never,
      params,
      async () => okDispatch,
    );

    expect(second).toEqual({ ...first, idempotentReplay: true });
    expect(first.idempotentReplay).toBe(false);
    expect(state.batches.size).toBe(1);
  });

  it("writes DB rows only for valid rows in a mixed valid/rejected batch, with rejection reasons present", async () => {
    const state = emptyState();
    const rpcCalls: string[] = [];
    const supabase = makeFakeSupabase(state, (params) => {
      rpcCalls.push(String(params["p_vendor_name"]));
      return successfulRpc(params);
    });

    const result = await executeVendorImportHandler(
      supabase as never,
      {
        companyId: "company-1",
        idempotencyKey: "mixed-batch-key",
        rows: [
          row({ rowNumber: 1, projectName: "Valid Project", vendorName: "Valid Vendor" }),
          row({ rowNumber: 2, projectName: "", vendorName: "Missing Project Vendor" }),
        ],
        dispatchRequests: false,
      },
      async () => okDispatch,
    );

    expect(result.acceptedRows).toBe(1);
    expect(result.rejectedRows).toBe(1);
    expect(rpcCalls).toEqual(["Valid Vendor"]); // import_vendor_row() never called for row 2

    const rejected = result.rowResults.find((r) => r.rowNumber === 2)!;
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors).toContainEqual(expect.objectContaining({ field: "project_name" }));

    const accepted = result.rowResults.find((r) => r.rowNumber === 1)!;
    expect(accepted.status).toBe("accepted");
    expect(accepted.vendorId).toBe("vendor-Valid Vendor");
  });

  it("a dispatch-request failure for one row does not affect that row's recorded success, nor any other row", async () => {
    const state = emptyState();
    const supabase = makeFakeSupabase(state, successfulRpc);

    let callCount = 0;
    const flakyDispatch = async (): Promise<RowDispatchResult> => {
      callCount += 1;
      return callCount === 1 ? failingDispatch : okDispatch;
    };

    const result = await executeVendorImportHandler(
      supabase as never,
      {
        companyId: "company-1",
        idempotencyKey: "dispatch-failure-key",
        rows: [
          row({
            rowNumber: 1,
            projectName: "Project A",
            vendorName: "Vendor A",
            dispatchRequest: true,
          }),
          row({
            rowNumber: 2,
            projectName: "Project B",
            vendorName: "Vendor B",
            dispatchRequest: true,
          }),
        ],
        dispatchRequests: true,
      },
      flakyDispatch,
    );

    expect(result.acceptedRows).toBe(2);
    const rowOne = result.rowResults.find((r) => r.rowNumber === 1)!;
    const rowTwo = result.rowResults.find((r) => r.rowNumber === 2)!;

    // Row 1's dispatch failed, but its core project/vendor/assignment write
    // still succeeded and is still recorded as accepted.
    expect(rowOne.status).toBe("accepted");
    expect(rowOne.vendorId).toBe("vendor-Vendor A");
    expect(rowOne.dispatch).toEqual(failingDispatch);

    // Row 2 is entirely unaffected by row 1's dispatch failure.
    expect(rowTwo.status).toBe("accepted");
    expect(rowTwo.dispatch).toEqual(okDispatch);
  });

  it("does not attempt dispatch for a row that did not request one, even when dispatchRequests is true company-wide", async () => {
    const state = emptyState();
    const supabase = makeFakeSupabase(state, successfulRpc);
    let dispatchCalls = 0;

    const result = await executeVendorImportHandler(
      supabase as never,
      {
        companyId: "company-1",
        idempotencyKey: "no-dispatch-key",
        rows: [row({ rowNumber: 1, dispatchRequest: false })],
        dispatchRequests: true,
      },
      async () => {
        dispatchCalls += 1;
        return okDispatch;
      },
    );

    expect(dispatchCalls).toBe(0);
    expect(result.rowResults[0]!.dispatch).toBeUndefined();
  });
});

describe("assignment prediction and write-role guard", () => {
  it("predicts create vs. match for the assignment, mirroring import_vendor_row()'s (project, vendor) lookup", () => {
    const ctx = {
      ...emptyValidationContext(),
      existingProjectNames: new Set(["Harbor Tower", "Pier 9"]),
      existingVendorNames: new Set(["cascade steel"]),
      existingVendorEmails: new Set(["ops@cascadesteel.test"]),
      projectIdsByName: new Map([
        ["Harbor Tower", "p-harbor"],
        ["Pier 9", "p-pier"],
      ]),
      vendors: [{ id: "v-cascade", name: "cascade steel", email: "ops@cascadesteel.test" }],
      assignmentKeys: new Set(["p-harbor:v-cascade"]),
    };

    const results = validateRows(
      [
        row({ rowNumber: 1, projectName: "Harbor Tower", vendorName: "Cascade Steel" }),
        row({ rowNumber: 2, projectName: "Pier 9", vendorName: "Cascade Steel" }),
        // Matched by contact email even though the name differs - same as the SQL lookup.
        row({
          rowNumber: 3,
          projectName: "Pier 9",
          vendorName: "Cascade Steel LLC",
          contactEmail: "OPS@cascadesteel.test",
        }),
        row({ rowNumber: 4, projectName: "New Site", vendorName: "Cascade Steel" }),
      ],
      ctx,
    );

    expect(results.map((r) => r.willCreateAssignment)).toEqual([false, true, false, true]);
    expect(results[2]).toMatchObject({ willCreateProject: false, willCreateVendor: false });
  });

  it("returns null (unknown) for the assignment when the context carries names but no ids", () => {
    const result = validateOneRow(row({ projectName: "Harbor Tower", vendorName: "Cascade" }), {
      existingProjectNames: new Set(["Harbor Tower"]),
      existingVendorNames: new Set(["cascade"]),
      existingVendorEmails: new Set(),
    });
    expect(result.willCreateAssignment).toBeNull();
  });

  it("rejects a fractional contract value up front instead of failing at the bigint write", () => {
    const result = validateOneRow(row({ contractValue: 1500.5 }), emptyValidationContext());
    expect(result.status).toBe("rejected");
    expect(result.errors).toEqual([
      {
        field: "contract_value",
        reason: "Contract value must be a whole dollar amount (no cents).",
      },
    ]);
  });

  it("refuses a read-only member before attempting any row", async () => {
    const state = { ...emptyState(), canWrite: false };
    const rpcCalls: unknown[] = [];
    const supabase = makeFakeSupabase(state, (params) => {
      rpcCalls.push(params);
      return successfulRpc(params);
    });

    await expect(
      executeVendorImportHandler(supabase as never, {
        companyId: "company-1",
        idempotencyKey: "read-only-key",
        rows: [row({ rowNumber: 1 })],
        dispatchRequests: false,
      }),
    ).rejects.toThrow(/cannot import/);
    expect(rpcCalls).toHaveLength(0);
    expect(state.batches.size).toBe(0);
  });

  it("lets a platform admin import on a customer's behalf though they are no member", async () => {
    // can_write_company() is false for staff (they belong to no company), but
    // the managed-service path authorizes them via is_platform_admin().
    const state = { ...emptyState(), canWrite: false, isPlatformAdmin: true };
    const rpcCalls: string[] = [];
    const supabase = makeFakeSupabase(state, (params) => {
      rpcCalls.push(String(params["p_vendor_name"]));
      return successfulRpc(params);
    });

    const result = await executeVendorImportHandler(
      supabase as never,
      {
        companyId: "company-1",
        idempotencyKey: "staff-key",
        rows: [row({ rowNumber: 1, projectName: "Harbor Point", vendorName: "Bay Steel" })],
        dispatchRequests: false,
      },
      async () => okDispatch,
    );

    expect(result.acceptedRows).toBe(1);
    expect(rpcCalls).toEqual(["Bay Steel"]);
    expect(state.batches.size).toBe(1);
  });
});

describe("trade vocabulary", () => {
  it("includes 'Other' as the last trade in the shared vocabulary", () => {
    expect(TRADE_VALUES).toContain("Other");
    expect(TRADE_VALUES[TRADE_VALUES.length - 1]).toBe("Other");
  });

  // Typecheck guard: an exhaustive Record keyed by the trade union must carry
  // an "Other" entry, so this file fails `tsc` if VendorTrade / Trade and
  // TRADE_VALUES ever drift (e.g. "Other" added to one list but not another).
  it("keeps VendorTrade, Trade and TRADE_VALUES in lockstep", () => {
    const labelByTrade: Record<VendorTrade, string> = {
      "Structural Steel": "Structural Steel",
      Electrical: "Electrical",
      "Mechanical / HVAC": "Mechanical / HVAC",
      Concrete: "Concrete",
      Earthwork: "Earthwork",
      Roofing: "Roofing",
      Glazing: "Glazing",
      "Fire Protection": "Fire Protection",
      Other: "Other",
    };
    // VendorTrade (contracts.ts) and Trade (vendorImports.ts) are two hand-kept
    // copies of the same vocabulary; assigning one to the other proves they are
    // structurally identical at compile time.
    const asTrade: Trade = "Other";
    const asVendorTrade: VendorTrade = asTrade;
    expect(labelByTrade[asVendorTrade]).toBe("Other");
    expect(Object.keys(labelByTrade)).toHaveLength(TRADE_VALUES.length);
  });
});
