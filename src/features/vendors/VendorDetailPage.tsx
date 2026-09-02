import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/AppShell";
import { ComplianceRail } from "@/components/compliance/ComplianceRail";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { RequestDocumentsAction } from "./RequestDocumentsAction";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function VendorDetailPage({ vendorId }: { vendorId: string }) {
  const repo = getRepository();
  const vendor = useQuery({
    queryKey: ["vendor", vendorId],
    queryFn: () => repo.getVendor(vendorId),
  });

  const data = vendor.data;

  return (
    <AppShell
      title={data?.name ?? "Vendor detail"}
      subtitle={data ? `${data.trade} · ${data.project}` : "Vendor compliance record"}
      actions={
        <Link
          to="/dashboard/vendors"
          className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
        >
          Back to vendors
        </Link>
      }
    >
      {vendor.isLoading ? (
        <LoadingState label="Loading vendor record" rows={5} />
      ) : vendor.isError ? (
        <ErrorState
          description="Demo vendor record failed to load."
          onRetry={() => void vendor.refetch()}
        />
      ) : !data ? (
        <EmptyState
          title="Vendor not found"
          description={`No demo vendor matches the id ${vendorId}.`}
        />
      ) : (
        <div className="space-y-6">
          <section aria-labelledby="rail-heading">
            <h2 id="rail-heading" className="text-sm font-semibold text-foreground">
              Compliance rail
            </h2>
            <ComplianceRail
              variant="detail"
              items={data.compliance}
              vendorName={data.name}
              className="mt-3"
            />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section
              aria-labelledby="limits-heading"
              className="rounded-md border border-border bg-card p-4"
            >
              <h2 id="limits-heading" className="text-sm font-semibold text-foreground">
                Coverage limits
              </h2>
              {data.limits.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No limits recorded for this vendor yet.
                </p>
              ) : (
                <table className="mt-3 w-full text-left text-sm">
                  <caption className="sr-only">Required versus carried coverage limits</caption>
                  <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-1 font-medium">
                        Coverage
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Required
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Carried
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.limits.map((limit) => {
                      const short = limit.carried < limit.required;
                      return (
                        <tr key={limit.label} className="border-t border-border">
                          <th scope="row" className="py-2 pr-2 font-normal">
                            {limit.label}
                          </th>
                          <td className="numeric py-2 pr-2 text-xs">
                            {currency.format(limit.required)}
                          </td>
                          <td
                            className={`numeric py-2 text-xs font-semibold ${
                              short ? "text-destructive" : "text-ok"
                            }`}
                          >
                            {currency.format(limit.carried)}
                            <span className="sr-only">
                              {short ? " below requirement" : " meets requirement"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            <section
              aria-labelledby="record-heading"
              className="rounded-md border border-border bg-card p-4"
            >
              <h2 id="record-heading" className="text-sm font-semibold text-foreground">
                Record
              </h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Policy number</dt>
                  <dd className="numeric text-xs">{data.policyNumber}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd className="numeric text-xs">{data.expiresOn}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Contract value</dt>
                  <dd className="numeric text-xs">{currency.format(data.contractValue)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Risk tier</dt>
                  <dd className="text-xs font-semibold uppercase">{data.riskTier}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Contact</dt>
                  <dd className="text-right text-xs">
                    {data.contactName}
                    <br />
                    {data.contactEmail}
                  </dd>
                </div>
              </dl>
              {isBackendConfigured() ? (
                <RequestDocumentsAction vendorId={data.id} />
              ) : (
                <p className="mt-4 rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                  Demo-only: document requests, uploads and reviews are simulated. Nothing is sent
                  or stored.
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </AppShell>
  );
}
