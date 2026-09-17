import { describe, expect, it } from "vitest";

import {
  buildExportFilename,
  csvEscapeField,
  exportReportHandler,
  rowsToCsv,
  sanitizeFilenamePart,
  type ReportRowsResult,
} from "@/workflows/reportExports";
import { parseCsv } from "@/workflows/vendorImports";

/**
 * Task 11b - src/workflows/reportExports.ts. RLS/permission enforcement
 * itself is proven against real Postgres for every underlying report query
 * (supabase/tests/reports.test.ts) - this file proves the TypeScript export
 * layer's own logic: CSV escaping (round-tripped through Task 11a's own
 * parseCsv(), the mirror-image problem this file solves), filename
 * sanitization, the explicit company-membership permission check, and that
 * a successful export writes an audit_log row - against a fake Supabase
 * client, the same split vendor-import.test.ts already established for
 * executeVendorImportHandler().
 */

// ---------------------------------------------------------------------------
// CSV escaping / round-trip
// ---------------------------------------------------------------------------

describe("csvEscapeField()", () => {
  it("leaves a plain value unquoted", () => {
    expect(csvEscapeField("Cascade Steel")).toBe("Cascade Steel");
  });

  it("quotes a value containing a comma", () => {
    expect(csvEscapeField("Harbor Tower, Phase 2")).toBe('"Harbor Tower, Phase 2"');
  });

  it("quotes and doubles embedded double quotes", () => {
    expect(csvEscapeField('Say "hello"')).toBe('"Say ""hello"""');
  });

  it("quotes a value containing an embedded newline", () => {
    expect(csvEscapeField("Line one\nLine two")).toBe('"Line one\nLine two"');
  });

  it("renders null/undefined as an empty field", () => {
    expect(csvEscapeField(null)).toBe("");
    expect(csvEscapeField(undefined)).toBe("");
  });
});

describe("rowsToCsv()", () => {
  interface Row {
    name: string;
    note: string;
    amount: number;
  }

  it("produces a header row plus one row per input, in the given column order", () => {
    const rows: Row[] = [{ name: "Cascade Steel", note: "ok", amount: 5 }];
    const csv = rowsToCsv(rows, [
      { key: "amount", header: "Amount" },
      { key: "name", header: "Name" },
      { key: "note", header: "Note" },
    ]);
    expect(csv).toBe("Amount,Name,Note\r\n5,Cascade Steel,ok");
  });

  it("round-trips values containing commas/quotes/newlines through Task 11a's own parseCsv()", () => {
    const rows: Row[] = [
      { name: "Harbor Tower, Phase 2", note: 'Reviewer said "looks good"', amount: 1 },
      { name: "Multi\nLine Co", note: "plain", amount: 2 },
    ];
    const csv = rowsToCsv(rows, [
      { key: "name", header: "Name" },
      { key: "note", header: "Note" },
      { key: "amount", header: "Amount" },
    ]);

    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(["Name", "Note", "Amount"]);
    expect(parsed[1]).toEqual(["Harbor Tower, Phase 2", 'Reviewer said "looks good"', "1"]);
    expect(parsed[2]).toEqual(["Multi\nLine Co", "plain", "2"]);
  });
});

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

describe("sanitizeFilenamePart()", () => {
  it("strips path-unsafe characters", () => {
    expect(sanitizeFilenamePart("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeFilenamePart("Acme\\Corp")).toBe("AcmeCorp");
    expect(sanitizeFilenamePart('bad"name<>|?*')).toBe("badname");
  });

  it("collapses whitespace to a single hyphen", () => {
    expect(sanitizeFilenamePart("Ridgeline   GC")).toBe("Ridgeline-GC");
  });

  it("falls back to a generic name when nothing safe remains", () => {
    expect(sanitizeFilenamePart("../../")).toBe("export");
  });
});

describe("buildExportFilename()", () => {
  it("builds an explicit, descriptive, sanitized .csv filename", () => {
    const filename = buildExportFilename(
      "Ridgeline GC",
      "open-deficiencies",
      new Date("2026-03-15T00:00:00Z"),
    );
    expect(filename).toBe("Ridgeline-GC-open-deficiencies-2026-03-15.csv");
  });

  it("sanitizes a path-traversal attempt in the company name", () => {
    const filename = buildExportFilename(
      "../../evil",
      "audit-snapshot",
      new Date("2026-03-15T00:00:00Z"),
    );
    expect(filename).not.toContain("..");
    expect(filename).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// exportReportHandler() - against a fake Supabase client.
// ---------------------------------------------------------------------------

interface FakeState {
  userId: string | null;
  members: Array<{ company_id: string; user_id: string; deactivated_at: string | null }>;
  auditLogInserts: Array<Record<string, unknown>>;
}

function makeFakeSupabase(state: FakeState) {
  function builderFor(table: string) {
    const filters: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fake query-builder for tests, same convention as vendor-import.test.ts's own makeFakeSupabase().
    const builder: any = {};
    Object.assign(builder, {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      is: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      insert: (payload: Record<string, unknown>) => {
        builder._insertPayload = payload;
        return builder;
      },
      maybeSingle: async () => {
        if (table === "company_members") {
          const match = state.members.find(
            (m) =>
              m.company_id === filters["company_id"] &&
              m.user_id === filters["user_id"] &&
              (filters["deactivated_at"] === null ? m.deactivated_at === null : true),
          );
          return { data: match ? { id: "member-1" } : null, error: null };
        }
        return { data: null, error: null };
      },
      then: (
        onFulfilled?: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        if (table === "audit_log" && builder._insertPayload) {
          state.auditLogInserts.push(builder._insertPayload);
          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
      },
    });
    return builder;
  }

  return {
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
    from: (table: string) => builderFor(table),
  };
}

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const NON_MEMBER_ID = "33333333-3333-3333-3333-333333333333";

const fakeRowsProvider = async (): Promise<ReportRowsResult> => ({
  csv: "Name\r\nCascade Steel",
  reportName: "fake-report",
  targetType: "company",
  targetId: COMPANY_ID,
  rowCount: 1,
});

describe("exportReportHandler()", () => {
  it("rejects a caller who is not a member of the company", async () => {
    const state: FakeState = { userId: NON_MEMBER_ID, members: [], auditLogInserts: [] };
    const supabase = makeFakeSupabase(state);

    await expect(
      exportReportHandler(
        supabase as never,
        {
          companyId: COMPANY_ID,
          companyName: "Ridgeline GC",
          reportKind: "open_deficiencies",
        },
        fakeRowsProvider,
      ),
    ).rejects.toThrow(/not authorized/i);

    expect(state.auditLogInserts).toHaveLength(0);
  });

  it("rejects an unauthenticated caller", async () => {
    const state: FakeState = { userId: null, members: [], auditLogInserts: [] };
    const supabase = makeFakeSupabase(state);

    await expect(
      exportReportHandler(
        supabase as never,
        {
          companyId: COMPANY_ID,
          companyName: "Ridgeline GC",
          reportKind: "open_deficiencies",
        },
        fakeRowsProvider,
      ),
    ).rejects.toThrow(/not signed in/i);
  });

  it("returns the CSV and writes an audit_log row for an authorized member", async () => {
    const state: FakeState = {
      userId: MEMBER_ID,
      members: [{ company_id: COMPANY_ID, user_id: MEMBER_ID, deactivated_at: null }],
      auditLogInserts: [],
    };
    const supabase = makeFakeSupabase(state);

    const result = await exportReportHandler(
      supabase as never,
      { companyId: COMPANY_ID, companyName: "Ridgeline GC", reportKind: "open_deficiencies" },
      fakeRowsProvider,
    );

    expect(result.csv).toBe("Name\r\nCascade Steel");
    expect(result.rowCount).toBe(1);
    expect(result.filename).toMatch(/^Ridgeline-GC-fake-report-\d{4}-\d{2}-\d{2}\.csv$/);

    expect(state.auditLogInserts).toHaveLength(1);
    expect(state.auditLogInserts[0]).toMatchObject({
      company_id: COMPANY_ID,
      actor_id: MEMBER_ID,
      action: "report_exported",
      target_type: "company",
      target_id: COMPANY_ID,
    });
  });

  it("rejects a deactivated member", async () => {
    const state: FakeState = {
      userId: MEMBER_ID,
      members: [
        { company_id: COMPANY_ID, user_id: MEMBER_ID, deactivated_at: "2026-01-01T00:00:00Z" },
      ],
      auditLogInserts: [],
    };
    const supabase = makeFakeSupabase(state);

    await expect(
      exportReportHandler(
        supabase as never,
        { companyId: COMPANY_ID, companyName: "Ridgeline GC", reportKind: "open_deficiencies" },
        fakeRowsProvider,
      ),
    ).rejects.toThrow(/not authorized/i);
  });
});
