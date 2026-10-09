import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { CompanyPlan } from "@/data/dbTypeAliases";
import { getRepository } from "@/data/repository";
import { PLAN_IDS, planLabel } from "@/domain/billing/plans";

export function CompaniesPage() {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => repo.listCompanies() });

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setPlan = useMutation({
    mutationFn: (v: { companyId: string; plan: CompanyPlan }) =>
      repo.setCompanyPlan(v.companyId, v.plan),
    onMutate: () => {
      setNotice(null);
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not change the plan."),
    onSuccess: (_data, v) => {
      setNotice(`Plan set to ${v.plan}.`);
      void queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
  });

  return (
    <AppShell title="Companies" subtitle="Customer accounts, plan coverage, and plan changes.">
      <AdminGuard>
        {companies.isLoading ? (
          <LoadingState label="Loading companies" rows={4} />
        ) : companies.isError ? (
          <ErrorState
            description="Company list failed to load."
            onRetry={() => void companies.refetch()}
          />
        ) : (companies.data ?? []).length === 0 ? (
          <EmptyState title="No companies" description="Customer accounts will appear here." />
        ) : (
          <div className="space-y-3">
            {error ? (
              <p
                role="alert"
                className="rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
              >
                {error}
              </p>
            ) : null}
            {notice ? (
              <p
                role="status"
                className="rounded-sm border border-border bg-muted px-3 py-2 text-xs"
              >
                {notice}
              </p>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full min-w-[720px] text-left text-sm">
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
                      <td className="px-3 py-3 text-xs">
                        <label className="sr-only" htmlFor={`plan-${company.id}`}>
                          Plan for {company.name}
                        </label>
                        <select
                          id={`plan-${company.id}`}
                          value={company.plan}
                          disabled={setPlan.isPending}
                          onChange={(e) =>
                            setPlan.mutate({
                              companyId: company.id,
                              plan: e.target.value as CompanyPlan,
                            })
                          }
                          className="focusable rounded-sm border border-input bg-background px-2 py-1 text-xs disabled:opacity-50"
                        >
                          {PLAN_IDS.map((plan) => (
                            <option key={plan} value={plan}>
                              {planLabel(plan)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="numeric px-3 py-3 text-xs">{company.vendors}</td>
                      <td className="numeric px-3 py-3 text-xs">{company.seats}</td>
                      <td className="numeric px-3 py-3 text-xs">{company.complianceRate}%</td>
                      <td className="numeric px-3 py-3 text-xs">{company.renewalOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
