import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { ComplianceRail } from "@/components/compliance/ComplianceRail";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { VendorForm } from "./VendorForm";
import { getRepository } from "@/data/repository";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function VendorsPage() {
  const repo = getRepository();
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => repo.listVendors() });

  const filtered = useMemo(() => {
    const list = vendors.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.trade.toLowerCase().includes(q) ||
        v.project.toLowerCase().includes(q),
    );
  }, [vendors.data, query]);

  return (
    <AppShell
      title="Vendors"
      subtitle="Subcontractor roster with the five-slot compliance rail."
      actions={
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          aria-expanded={showForm}
          className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          {showForm ? "Close vendor form" : "Add vendor"}
        </button>
      }
    >
      <div className="space-y-4">
        {showForm ? <VendorForm onDone={() => setShowForm(false)} /> : null}

        <div className="max-w-sm">
          <label htmlFor="vendor-search" className="block text-sm font-medium text-foreground">
            Search vendors
          </label>
          <input
            id="vendor-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, trade or project"
            className="focusable mt-1 w-full rounded-sm border border-input bg-card px-3 py-2 text-sm"
          />
        </div>

        {vendors.isLoading ? (
          <LoadingState label="Loading vendor roster" rows={6} />
        ) : vendors.isError ? (
          <ErrorState
            description="Demo vendor roster failed to load."
            onRetry={() => void vendors.refetch()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No vendors match this search"
            description="Adjust the search term or clear it to see the full roster."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">
                Vendor roster with compliance rail, policy numbers and expiration dates
              </caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Vendor
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Compliance rail
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Policy
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Contract
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((vendor) => (
                  <tr key={vendor.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-3 py-3">
                      <Link
                        to="/dashboard/vendors/$vendorId"
                        params={{ vendorId: vendor.id }}
                        aria-label={`Open vendor detail for ${vendor.name}`}
                        className="focusable font-semibold text-foreground underline-offset-2 hover:underline"
                      >
                        {vendor.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {vendor.trade} · {vendor.project}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <ComplianceRail items={vendor.compliance} vendorName={vendor.name} />
                    </td>
                    <td className="numeric px-3 py-3 text-xs">{vendor.policyNumber}</td>
                    <td className="numeric px-3 py-3 text-xs">{vendor.expiresOn}</td>
                    <td className="numeric px-3 py-3 text-xs">
                      {currency.format(vendor.contractValue)}
                    </td>
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
