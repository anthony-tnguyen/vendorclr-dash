import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AdminGuard } from "./AdminGuard";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { CompanyPlan } from "@/data/dbTypeAliases";
import { getRepository } from "@/data/repository";
import { PLAN_IDS, planLabel } from "@/domain/billing/plans";
import { VendorForm } from "@/features/vendors/VendorForm";
import { VendorCommunicationsSection } from "@/features/vendors/VendorCommunicationsSection";

/**
 * Managed-service vendor panel: the roster of one company's vendors plus an
 * add-vendor form bound to that company. Staff read via the is_platform_admin()
 * branch of vendors_select; the add goes through the admin_create_vendor RPC
 * (migration 20261009140000), so no vendors write policy is widened.
 */
function CompanyVendorsPanel({
  companyId,
  companyName,
}: {
  companyId: string;
  companyName: string;
}) {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const vendorsKey = ["admin", "company-vendors", companyId];
  const vendors = useQuery({
    queryKey: vendorsKey,
    queryFn: () => repo.listCompanyVendors(companyId),
  });
  const [adding, setAdding] = useState(false);
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [editingVendor, setEditingVendor] = useState<string | null>(null);

  const archive = useMutation({
    mutationFn: (vendorId: string) => repo.adminArchiveVendor(vendorId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: vendorsKey }),
  });

  return (
    <div className="space-y-3 rounded-md border border-border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Vendors — {companyName}</h3>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="focusable rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
          >
            Add vendor
          </button>
        ) : null}
      </div>

      {adding ? (
        <VendorForm
          create={(draft) => repo.adminCreateVendor(companyId, draft)}
          invalidateKey={vendorsKey}
          onDone={() => setAdding(false)}
        />
      ) : null}

      {vendors.isLoading ? (
        <LoadingState label="Loading vendors" rows={3} />
      ) : vendors.isError ? (
        <ErrorState
          description="Could not load this company's vendors."
          onRetry={() => void vendors.refetch()}
        />
      ) : (vendors.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No vendors yet. Add one on this company's behalf.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-sm border border-border bg-card">
          <table className="w-full min-w-[680px] text-left text-sm">
            <caption className="sr-only">{companyName} vendors</caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Vendor
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Trade
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Project
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Contract
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Requests
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Manage
                </th>
              </tr>
            </thead>
            <tbody>
              {(vendors.data ?? []).map((v) => {
                const open = openVendor === v.id;
                const editing = editingVendor === v.id;
                return (
                  <Fragment key={v.id}>
                    <tr className="border-b border-border last:border-0">
                      <th scope="row" className="px-3 py-2 font-medium">
                        {v.name}
                      </th>
                      <td className="px-3 py-2 text-xs">{v.trade}</td>
                      <td className="px-3 py-2 text-xs">{v.project}</td>
                      <td className="numeric px-3 py-2 text-xs">
                        ${v.contractValue.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setOpenVendor(open ? null : v.id)}
                          className="focusable rounded-sm border border-input px-2 py-1 text-xs font-semibold"
                        >
                          {open ? "Hide" : "Contacts & COI"}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            aria-expanded={editing}
                            onClick={() => setEditingVendor(editing ? null : v.id)}
                            className="focusable rounded-sm border border-input px-2 py-1 text-xs font-semibold"
                          >
                            {editing ? "Close" : "Edit"}
                          </button>
                          <button
                            type="button"
                            disabled={archive.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Archive ${v.name}? It leaves the active roster but its compliance history is kept.`,
                                )
                              ) {
                                archive.mutate(v.id);
                              }
                            }}
                            className="focusable rounded-sm border border-input px-2 py-1 text-xs font-semibold text-destructive disabled:opacity-50"
                          >
                            Archive
                          </button>
                        </div>
                      </td>
                    </tr>
                    {editing ? (
                      <tr className="border-b border-border last:border-0">
                        <td colSpan={6} className="px-3 py-3">
                          <VendorForm
                            heading={`Edit ${v.name}`}
                            submitLabel="Save changes"
                            initial={{
                              name: v.name,
                              trade: v.trade,
                              project: v.project,
                              contactName: v.contactName,
                              contactEmail: v.contactEmail,
                              contractValue: v.contractValue,
                            }}
                            create={(draft) => repo.adminUpdateVendor(v.id, draft)}
                            invalidateKey={vendorsKey}
                            successMessage={(vendor) => `${vendor.name} was updated.`}
                            onDone={() => setEditingVendor(null)}
                          />
                        </td>
                      </tr>
                    ) : null}
                    {open ? (
                      <tr className="border-b border-border last:border-0">
                        <td colSpan={6} className="px-3 py-3">
                          <VendorCommunicationsSection vendorId={v.id} canWrite />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CompaniesPage() {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const { enterCompany } = useSession();
  const navigate = useNavigate();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => repo.listCompanies() });

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
    <AppShell
      title="Companies"
      subtitle="Customer accounts: plan coverage, plan changes, and managed-service vendors."
    >
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
              <table className="w-full min-w-[760px] text-left text-sm">
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
                  {(companies.data ?? []).map((company) => {
                    const isOpen = expanded === company.id;
                    return (
                      <Fragment key={company.id}>
                        <tr className="border-b border-border last:border-0">
                          <th scope="row" className="px-3 py-3 font-medium">
                            {company.name}
                            <button
                              type="button"
                              onClick={() => {
                                enterCompany(company.id, company.name);
                                void navigate({ to: "/dashboard" });
                              }}
                              className="focusable mt-1 block text-left text-[11px] font-normal text-primary underline"
                            >
                              Open console as this company →
                            </button>
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
                          <td className="px-3 py-3 text-xs">
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              onClick={() => setExpanded(isOpen ? null : company.id)}
                              className="focusable rounded-sm border border-input px-2 py-1 text-xs font-semibold"
                            >
                              <span className="numeric">{company.vendors}</span> ·{" "}
                              {isOpen ? "Hide" : "Manage"}
                            </button>
                          </td>
                          <td className="numeric px-3 py-3 text-xs">{company.seats}</td>
                          <td className="numeric px-3 py-3 text-xs">{company.complianceRate}%</td>
                          <td className="numeric px-3 py-3 text-xs">{company.renewalOn}</td>
                        </tr>
                        {isOpen ? (
                          <tr className="border-b border-border last:border-0">
                            <td colSpan={6} className="px-3 py-3">
                              <CompanyVendorsPanel
                                companyId={company.id}
                                companyName={company.name}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
