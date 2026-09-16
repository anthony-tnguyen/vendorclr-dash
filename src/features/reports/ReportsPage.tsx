import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository, isBackendConfigured } from "@/data/repository";

export function ReportsPage() {
  const repo = getRepository();
  const [notice, setNotice] = useState<string | null>(null);
  const isDemo = !isBackendConfigured();
  const rows = useQuery({ queryKey: ["reports"], queryFn: () => repo.listReportRows() });

  return (
    <AppShell
      title="Reports"
      subtitle="Project level compliance rollup for the current period."
      actions={
        <button
          type="button"
          disabled={!isDemo}
          onClick={() => setNotice("Demo mode: no file was generated, exported or downloaded.")}
          className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isDemo ? "Export CSV (demo)" : "CSV export is not available"}
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
