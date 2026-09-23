import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository, isBackendConfigured } from "@/data/repository";
import {
  REPORT_DEFINITIONS,
  REPORT_KINDS,
  formatReportCell,
  type ReportKind,
} from "@/workflows/reportCatalog";
import { downloadCsv } from "@/lib/download";
import { exportReport, getReportRows } from "@/workflows/reportExports";

export function ReportsPage({ report }: { report?: ReportKind | undefined }) {
  const isDemo = !isBackendConfigured();
  return isDemo ? <DemoReports /> : <LiveReports report={report ?? "compliance_by_project"} />;
}

function LiveReports({ report }: { report: ReportKind }) {
  const { companyId, companyName } = useSession();
  const navigate = useNavigate();
  const definition = REPORT_DEFINITIONS[report];
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useQuery({
    queryKey: ["report-rows", companyId, report],
    queryFn: () => getReportRows({ data: { companyId: companyId!, reportKind: report } }),
    enabled: !!companyId,
  });

  const exporter = useMutation({
    mutationFn: () =>
      exportReport({
        data: {
          companyId: companyId!,
          companyName: companyName || "VendorClr",
          reportKind: report,
        },
      }),
    onSuccess: (result) => {
      downloadCsv(result.filename, result.csv);
      setNotice(
        `Downloaded ${result.filename} (${result.rowCount} row${result.rowCount === 1 ? "" : "s"}). The export was recorded in your company's audit history.`,
      );
    },
  });

  const data = rows.data?.rows ?? [];

  return (
    <AppShell
      title="Reports"
      subtitle="Assignment-based compliance reporting for your company."
      actions={
        <button
          type="button"
          disabled={!companyId || exporter.isPending || rows.isLoading || rows.isError}
          onClick={() => {
            setNotice(null);
            exporter.mutate();
          }}
          className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {exporter.isPending ? "Preparing CSV…" : "Export CSV"}
        </button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1">
            <label htmlFor="report-select" className="text-sm font-medium text-foreground">
              Report
            </label>
            <select
              id="report-select"
              value={report}
              onChange={(event) => {
                setNotice(null);
                exporter.reset();
                void navigate({
                  to: "/dashboard/reports",
                  search: { report: event.target.value as ReportKind },
                });
              }}
              className="focusable rounded-sm border border-input bg-background px-2 py-1.5 text-sm sm:min-w-72"
            >
              {REPORT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {REPORT_DEFINITIONS[kind].label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground sm:pb-2">{definition.description}</p>
        </div>

        {notice ? (
          <p role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
            {notice}
          </p>
        ) : null}
        {exporter.isError ? (
          <p role="alert" className="text-xs font-semibold text-destructive">
            {exporter.error instanceof Error
              ? exporter.error.message
              : "Could not export this report."}
          </p>
        ) : null}

        {!companyId ? (
          <EmptyState
            title="No company workspace"
            description="Reports are available once your account belongs to an activated company."
          />
        ) : rows.isLoading ? (
          <LoadingState label="Loading report rows" rows={3} />
        ) : rows.isError ? (
          <ErrorState
            description={
              rows.error instanceof Error ? rows.error.message : "Could not load report data."
            }
            onRetry={() => void rows.refetch()}
          />
        ) : data.length === 0 ? (
          <EmptyState
            title={`Nothing in "${definition.label}"`}
            description="No assignments, policies or events in your company match this report right now."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full min-w-[640px] text-left text-sm" data-testid="report-table">
              <caption className="sr-only">{definition.label}</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  {definition.columns.map((column) => (
                    <th key={column.key} scope="col" className="px-3 py-2 font-medium">
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row, index) => (
                  <tr key={index} className="border-b border-border last:border-0">
                    {definition.columns.map((column, columnIndex) =>
                      columnIndex === 0 ? (
                        <th key={column.key} scope="row" className="px-3 py-3 font-medium">
                          {formatReportCell(row[column.key] ?? null)}
                        </th>
                      ) : (
                        <td key={column.key} className="px-3 py-3 text-xs">
                          {formatReportCell(row[column.key] ?? null)}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {data.length} row{data.length === 1 ? "" : "s"}
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** Sample-data mode: the original project rollup over demo data. Nothing is generated or downloaded. */
function DemoReports() {
  const repo = getRepository();
  const [notice, setNotice] = useState<string | null>(null);
  const rows = useQuery({ queryKey: ["reports"], queryFn: () => repo.listReportRows() });

  return (
    <AppShell
      title="Reports"
      subtitle="Project level compliance rollup for the current period."
      actions={
        <button
          type="button"
          onClick={() => setNotice("Demo mode: no file was generated, exported or downloaded.")}
          className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
        >
          Export CSV (demo)
        </button>
      }
    >
      <div className="space-y-4">
        {notice ? (
          <p role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
            {notice}
          </p>
        ) : null}

        {rows.isLoading ? (
          <LoadingState label="Loading report rows" rows={3} />
        ) : rows.isError ? (
          <ErrorState
            description="Could not load report data."
            onRetry={() => void rows.refetch()}
          />
        ) : (rows.data ?? []).length === 0 ? (
          <EmptyState
            title="No reportable projects"
            description="Projects appear here once vendors are assigned to them."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full min-w-[640px] text-left text-sm">
              <caption className="sr-only">Compliance rollup by project</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Project
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Vendors
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Compliant
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Expiring 30d
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Open exceptions
                  </th>
                </tr>
              </thead>
              <tbody>
                {(rows.data ?? []).map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <th scope="row" className="px-3 py-3 font-medium">
                      {row.project}
                    </th>
                    <td className="numeric px-3 py-3 text-xs">{row.vendors}</td>
                    <td className="numeric px-3 py-3 text-xs">{row.compliantPct}%</td>
                    <td className="numeric px-3 py-3 text-xs">{row.expiringIn30}</td>
                    <td className="numeric px-3 py-3 text-xs">{row.openExceptions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
