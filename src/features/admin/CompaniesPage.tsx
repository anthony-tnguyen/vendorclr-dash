import { useQuery } from "@tanstack/react-query";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";

export function CompaniesPage() {
  const repo = getRepository();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => repo.listCompanies() });

  return (
    <AppShell title="Companies" subtitle="Customer accounts and plan coverage.">
      <AdminGuard>
        {companies.isLoading ? (
          <LoadingState label="Loading companies" rows={4} />
        ) : companies.isError ? (
          <ErrorState
            description="Demo company list failed to load."
            onRetry={() => void companies.refetch()}
          />
        ) : (companies.data ?? []).length === 0 ? (
          <EmptyState title="No companies" description="Customer accounts will appear here." />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full min-w-[680px] text-left text-sm">
              <caption className="sr-only">Customer companies</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Company
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Plan
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Vendors
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Seats
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Compliance
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Renews
                  </th>
                </tr>
              </thead>
              <tbody>
                {(companies.data ?? []).map((company) => (
                  <tr key={company.id} className="border-b border-border last:border-0">
                    <th scope="row" className="px-3 py-3 font-medium">
                      {company.name}
                    </th>
                    <td className="px-3 py-3 text-xs">{company.plan}</td>
                    <td className="numeric px-3 py-3 text-xs">{company.vendors}</td>
                    <td className="numeric px-3 py-3 text-xs">{company.seats}</td>
                    <td className="numeric px-3 py-3 text-xs">{company.complianceRate}%</td>
                    <td className="numeric px-3 py-3 text-xs">{company.renewalOn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
