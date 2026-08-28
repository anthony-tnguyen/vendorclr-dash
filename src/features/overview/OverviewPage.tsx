import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/AppShell";
import { ComplianceRail } from "@/components/compliance/ComplianceRail";
import { EmptyState, ErrorState, LoadingState, StateGallery } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";

export function OverviewPage() {
  const repo = getRepository();
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: () => repo.listOverviewMetrics() });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => repo.listVendors() });

  const attention = (vendors.data ?? []).filter((v) =>
    v.compliance.some((c) => c.status !== "compliant"),
  );

  return (
    <AppShell
      title="Program overview"
      subtitle="Compliance posture across active construction projects. Demo data only."
    >
      <div className="space-y-6">
        <section aria-labelledby="metrics-heading">
          <h2 id="metrics-heading" className="text-sm font-semibold text-foreground">
            Current position
          </h2>
          {metrics.isLoading ? (
            <div className="mt-3">
              <LoadingState label="Loading program metrics" rows={2} />
            </div>
          ) : metrics.isError ? (
            <div className="mt-3">
              <ErrorState
                description="Demo metrics failed to load."
                onRetry={() => void metrics.refetch()}
              />
            </div>
          ) : (
            <dl className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {(metrics.data ?? []).map((m) => (
                <div key={m.id} className="rounded-md border border-border bg-card p-4">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {m.label}
                  </dt>
                  <dd className="numeric mt-1 text-2xl font-semibold text-foreground">{m.value}</dd>
                  <p className="mt-1 text-xs text-muted-foreground">{m.detail}</p>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section aria-labelledby="attention-heading">
          <div className="flex items-center justify-between">
            <h2 id="attention-heading" className="text-sm font-semibold text-foreground">
              Vendors needing attention
            </h2>
            <Link
              to="/dashboard/vendors"
              className="focusable text-sm font-medium text-primary underline"
            >
              View all vendors
            </Link>
          </div>
          <div className="mt-3 space-y-2">
            {vendors.isLoading ? (
              <LoadingState label="Loading vendor compliance" />
            ) : vendors.isError ? (
              <ErrorState
                description="Demo vendor list failed to load."
                onRetry={() => void vendors.refetch()}
              />
            ) : attention.length === 0 ? (
              <EmptyState
                title="No exceptions open"
                description="Every tracked requirement is current across your roster."
              />
            ) : (
              attention.map((vendor) => (
                <article
                  key={vendor.id}
                  className="rounded-md border border-border bg-card p-3 sm:flex sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      to="/dashboard/vendors/$vendorId"
                      params={{ vendorId: vendor.id }}
                      className="focusable text-sm font-semibold text-foreground underline-offset-2 hover:underline"
                    >
                      {vendor.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {vendor.trade} · {vendor.project}
                    </p>
                  </div>
                  <ComplianceRail
                    items={vendor.compliance}
                    vendorName={vendor.name}
                    className="mt-2 sm:mt-0"
                  />
                </article>
              ))
            )}
          </div>
        </section>

        <StateGallery />
      </div>
    </AppShell>
  );
}
