import { describe, expect, it } from "vitest";

import {
  buildManifest,
  exportCompanyTables,
  fetchCompanyName,
  listCompanyStorageObjects,
  type StorageObjectListing,
} from "../../scripts/export-company";
import {
  assertDeletionAuthorized,
  executeDeletion,
  parseDeleteArgs,
  planDeletion,
  type ParsedDeleteArgs,
} from "../../scripts/delete-company";
import { countCompanyRows } from "../../scripts/lib/companyLookup";
import { COMPANY_SCOPED_TABLES } from "../../scripts/lib/companyScopedTables";

/**
 * Task 12 - unit tests for export-company.ts / delete-company.ts's own
 * TypeScript logic against a fake Supabase client, the same
 * "mocked client proves this function builds the right query and behaves
 * correctly; a live project is not required for that" split
 * vendor-import.test.ts (Task 11a) and feature-flags.test.ts already
 * establish for this codebase. Neither script is ever run against a real
 * project in CI; RLS/schema-shape coverage is a separate concern these
 * tests do not attempt.
 *
 * Three things this file is specifically responsible for proving, per the
 * plan's own wording for this task:
 *
 *   1. delete-company.ts actually refuses to proceed without ALL required
 *      confirmations (id + name + backup-reference + second-approver).
 *   2. Dry-run mode makes zero write calls to the fake client.
 *   3. The table enumeration used by both scripts is the SAME list - no
 *      drift between what export-company.ts claims to cover and what
 *      delete-company.ts claims to cover.
 */

interface FakeTableRow {
  id: string;
  company_id: string;
  [key: string]: unknown;
}

interface FakeState {
  companies: Array<{ id: string; name: string }>;
  tables: Record<string, FakeTableRow[]>;
  storageObjects: Array<{ path: string; size: number }>;
}

interface FakeCalls {
  removedPaths: string[];
  downloadedPaths: string[];
  deletedCompanyIds: string[];
}

function makeFakeSupabase(state: FakeState, calls: FakeCalls) {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let selectOpts: { head?: boolean; count?: string } | undefined;
    let isDelete = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake query-builder for tests, same convention as vendor-import.test.ts's makeFakeSupabase().
    const builder: any = {};
    Object.assign(builder, {
      select: (_cols: string, opts?: { head?: boolean; count?: string }) => {
        selectOpts = opts;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      delete: () => {
        isDelete = true;
        return builder;
      },
      maybeSingle: async () => {
        if (table === "companies") {
          const row = state.companies.find((c) => c.id === filters["id"]);
          return { data: row ? { name: row.name } : null, error: null };
        }
        return { data: null, error: null };
      },
      then: (
        onFulfilled?: (value: { data: unknown; error: unknown; count?: number }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        let result: { data: unknown; error: unknown; count?: number };
        if (isDelete) {
          calls.deletedCompanyIds.push(String(filters["id"]));
          state.companies = state.companies.filter((c) => c.id !== filters["id"]);
          result = { data: null, error: null };
        } else if (selectOpts?.head) {
          const rows = (state.tables[table] ?? []).filter(
            (r) => r.company_id === filters["company_id"],
          );
          result = { data: null, error: null, count: rows.length };
        } else {
          const rows = (state.tables[table] ?? []).filter(
            (r) => r.company_id === filters["company_id"],
          );
          result = { data: rows, error: null };
        }
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    });
    return builder;
  }

  function storageFrom(bucket: string) {
    return {
      list: async (dir: string, _opts?: unknown) => {
        const prefix = `${dir}/`;
        const children = new Map<
          string,
          { id: string | null; name: string; metadata?: { size: number } }
        >();
        for (const obj of state.storageObjects) {
          if (!obj.path.startsWith(prefix)) continue;
          const rest = obj.path.slice(prefix.length);
          const parts = rest.split("/");
          const first = parts[0]!;
          if (parts.length > 1) {
            children.set(first, { id: null, name: first });
          } else {
            children.set(first, { id: `file-${first}`, name: first, metadata: { size: obj.size } });
          }
        }
        return { data: [...children.values()], error: null };
      },
      download: async (path: string) => {
        calls.downloadedPaths.push(path);
        return {
          data: { arrayBuffer: async () => new TextEncoder().encode("fake-bytes").buffer },
          error: null,
        };
      },
      remove: async (paths: string[]) => {
        calls.removedPaths.push(...paths);
        state.storageObjects = state.storageObjects.filter((o) => !paths.includes(o.path));
        return { error: null };
      },
      // Only bucket the fake needs to answer for.
      __bucket: bucket,
    };
  }

  return {
    from,
    storage: { from: storageFrom },
  };
}

function emptyState(): FakeState {
  return { companies: [], tables: {}, storageObjects: [] };
}

function emptyCalls(): FakeCalls {
  return { removedPaths: [], downloadedPaths: [], deletedCompanyIds: [] };
}

// ---------------------------------------------------------------------------
// Table enumeration consistency - export and delete must use the SAME list.
// ---------------------------------------------------------------------------

describe("table enumeration consistency between export-company.ts and delete-company.ts", () => {
  it("exportCompanyTables() and countCompanyRows() both cover exactly COMPANY_SCOPED_TABLES, in the same order", async () => {
    const state = emptyState();
    state.companies.push({ id: "company-1", name: "Acme Construction LLC" });
    const supabase = makeFakeSupabase(state, emptyCalls());

    const exported = await exportCompanyTables(supabase as never, "company-1");
    const counted = await countCompanyRows(supabase as never, "company-1");

    expect(exported.map((e) => e.table)).toEqual([...COMPANY_SCOPED_TABLES]);
    expect(counted.map((c) => c.table)).toEqual([...COMPANY_SCOPED_TABLES]);
    // The two independent code paths (full-row export vs. count-only) must
    // report the identical table set - a table present in one but not the
    // other is exactly the drift this test exists to catch.
    expect(exported.map((e) => e.table)).toEqual(counted.map((c) => c.table));
  });

  it("COMPANY_SCOPED_TABLES has no duplicate entries", () => {
    expect(new Set(COMPANY_SCOPED_TABLES).size).toBe(COMPANY_SCOPED_TABLES.length);
  });
});

// ---------------------------------------------------------------------------
// export-company.ts logic
// ---------------------------------------------------------------------------

describe("exportCompanyTables()", () => {
  it("reads only rows belonging to the given company from every table", async () => {
    const state = emptyState();
    state.tables["vendors"] = [
      { id: "v1", company_id: "company-1", name: "Cascade Steel" },
      { id: "v2", company_id: "company-2", name: "Other Co Vendor" },
    ];
    const supabase = makeFakeSupabase(state, emptyCalls());

    const result = await exportCompanyTables(supabase as never, "company-1");
    const vendors = result.find((r) => r.table === "vendors")!;
    expect(vendors.rowCount).toBe(1);
    expect(vendors.rows).toEqual([{ id: "v1", company_id: "company-1", name: "Cascade Steel" }]);
  });
});

describe("fetchCompanyName()", () => {
  it("returns the company's name when it exists", async () => {
    const state = emptyState();
    state.companies.push({ id: "company-1", name: "Acme Construction LLC" });
    const supabase = makeFakeSupabase(state, emptyCalls());
    expect(await fetchCompanyName(supabase as never, "company-1")).toBe("Acme Construction LLC");
  });

  it("returns null for an unknown company id", async () => {
    const supabase = makeFakeSupabase(emptyState(), emptyCalls());
    expect(await fetchCompanyName(supabase as never, "nonexistent")).toBeNull();
  });
});

describe("listCompanyStorageObjects()", () => {
  it("recursively walks nested folders and returns every object with its size", async () => {
    const state = emptyState();
    state.storageObjects = [
      { path: "company/company-1/vendor/v1/documents/coi.pdf", size: 100 },
      { path: "company/company-1/vendor/v2/documents/coi.pdf", size: 200 },
      { path: "company/company-2/vendor/v9/documents/other.pdf", size: 999 }, // different company - must not appear
    ];
    const supabase = makeFakeSupabase(state, emptyCalls());

    const objects = await listCompanyStorageObjects(
      supabase as never,
      "vendor-documents",
      "company/company-1",
    );
    expect(objects).toHaveLength(2);
    expect(objects.map((o) => o.path).sort()).toEqual([
      "company/company-1/vendor/v1/documents/coi.pdf",
      "company/company-1/vendor/v2/documents/coi.pdf",
    ]);
    expect(objects.reduce((sum, o) => sum + o.size, 0)).toBe(300);
  });
});

describe("buildManifest()", () => {
  it("summarizes table row counts and storage totals", () => {
    const manifest = buildManifest(
      "company-1",
      "Acme Construction LLC",
      [
        { table: "vendors", rowCount: 3, rows: [] },
        { table: "audit_log", rowCount: 10, rows: [] },
      ],
      [
        { path: "a", size: 10 },
        { path: "b", size: 20 },
      ] as StorageObjectListing[],
    );
    expect(manifest.tables).toEqual([
      { table: "vendors", rowCount: 3 },
      { table: "audit_log", rowCount: 10 },
    ]);
    expect(manifest.storage).toEqual({
      bucket: "vendor-documents",
      objectCount: 2,
      totalBytes: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// delete-company.ts - confirmation enforcement
// ---------------------------------------------------------------------------

describe("parseDeleteArgs()", () => {
  it("defaults to a non-executing (dry-run) invocation with just a company id", () => {
    const parsed = parseDeleteArgs(["company-1"]);
    expect(parsed).toMatchObject({ companyId: "company-1", execute: false });
  });

  it("parses --execute plus all three confirmation flags", () => {
    const parsed = parseDeleteArgs([
      "company-1",
      "--execute",
      "--confirm-name=Acme Construction LLC",
      "--backup-reference=pitr-2026-09-17",
      "--second-approver=jane@vendorclr.com",
    ]);
    expect(parsed).toEqual({
      companyId: "company-1",
      execute: true,
      confirmName: "Acme Construction LLC",
      backupReference: "pitr-2026-09-17",
      secondApprover: "jane@vendorclr.com",
    });
  });

  it("errors with no company id at all", () => {
    const parsed = parseDeleteArgs([]);
    expect("error" in parsed).toBe(true);
  });
});

describe("assertDeletionAuthorized()", () => {
  const baseArgs: ParsedDeleteArgs = {
    companyId: "company-1",
    execute: true,
    confirmName: "Acme Construction LLC",
    backupReference: "pitr-2026-09-17",
    secondApprover: "jane@vendorclr.com",
  };

  it("authorizes when --execute and all three confirmations are present and the name matches exactly", () => {
    const result = assertDeletionAuthorized(baseArgs, "Acme Construction LLC");
    expect(result).toEqual({ authorized: true });
  });

  it("refuses when --execute was not passed, even if every other confirmation is present", () => {
    const result = assertDeletionAuthorized(
      { ...baseArgs, execute: false },
      "Acme Construction LLC",
    );
    expect(result.authorized).toBe(false);
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("--execute");
  });

  it("refuses when confirm-name is missing", () => {
    const result = assertDeletionAuthorized(
      { ...baseArgs, confirmName: null },
      "Acme Construction LLC",
    );
    expect(result.authorized).toBe(false);
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("--confirm-name");
  });

  it("refuses when confirm-name does not exactly match the company's on-file name", () => {
    const result = assertDeletionAuthorized(
      { ...baseArgs, confirmName: "acme construction llc" }, // different case
      "Acme Construction LLC",
    );
    expect(result.authorized).toBe(false);
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("does not exactly match");
  });

  it("refuses when backup-reference is missing", () => {
    const result = assertDeletionAuthorized(
      { ...baseArgs, backupReference: null },
      "Acme Construction LLC",
    );
    expect(result.authorized).toBe(false);
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("--backup-reference");
  });

  it("refuses when second-approver is missing", () => {
    const result = assertDeletionAuthorized(
      { ...baseArgs, secondApprover: null },
      "Acme Construction LLC",
    );
    expect(result.authorized).toBe(false);
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("--second-approver");
  });

  it("reports every unmet requirement at once when all four are missing", () => {
    const result = assertDeletionAuthorized(
      {
        companyId: "company-1",
        execute: false,
        confirmName: null,
        backupReference: null,
        secondApprover: null,
      },
      "Acme Construction LLC",
    );
    expect(result.authorized).toBe(false);
    const reasons = (result as { reasons: string[] }).reasons;
    expect(reasons).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// delete-company.ts - dry run makes zero writes
// ---------------------------------------------------------------------------

describe("planDeletion() (dry run)", () => {
  it("reads counts and storage listings but issues no delete/remove calls", async () => {
    const state = emptyState();
    state.companies.push({ id: "company-1", name: "Acme Construction LLC" });
    state.tables["vendors"] = [{ id: "v1", company_id: "company-1" }];
    state.tables["audit_log"] = [
      { id: "a1", company_id: "company-1" },
      { id: "a2", company_id: "company-1" },
    ];
    state.storageObjects = [{ path: "company/company-1/vendor/v1/documents/coi.pdf", size: 50 }];
    const calls = emptyCalls();
    const supabase = makeFakeSupabase(state, calls);

    const plan = await planDeletion(supabase as never, "company-1", "Acme Construction LLC");

    expect(plan.tables.find((t) => t.table === "vendors")?.rowCount).toBe(1);
    expect(plan.tables.find((t) => t.table === "audit_log")?.rowCount).toBe(2);
    expect(plan.storage.objectCount).toBe(1);

    // The load-bearing assertion: a dry run must not call storage.remove()
    // or companies.delete() - zero write calls to the fake client.
    expect(calls.removedPaths).toHaveLength(0);
    expect(calls.deletedCompanyIds).toHaveLength(0);

    // The company and its rows are still present after a dry run.
    expect(state.companies).toHaveLength(1);
    expect(state.tables["vendors"]).toHaveLength(1);
    expect(state.storageObjects).toHaveLength(1);
  });
});

describe("executeDeletion()", () => {
  it("deletes storage objects and the companies row (which cascades every other table)", async () => {
    const state = emptyState();
    state.companies.push({ id: "company-1", name: "Acme Construction LLC" });
    state.storageObjects = [{ path: "company/company-1/vendor/v1/documents/coi.pdf", size: 50 }];
    const calls = emptyCalls();
    const supabase = makeFakeSupabase(state, calls);

    await executeDeletion(supabase as never, "company-1", [
      { path: "company/company-1/vendor/v1/documents/coi.pdf", size: 50 },
    ]);

    expect(calls.removedPaths).toEqual(["company/company-1/vendor/v1/documents/coi.pdf"]);
    expect(calls.deletedCompanyIds).toEqual(["company-1"]);
    expect(state.companies).toHaveLength(0);
    expect(state.storageObjects).toHaveLength(0);
  });
});
