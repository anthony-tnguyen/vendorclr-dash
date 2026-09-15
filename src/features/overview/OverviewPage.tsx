import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/AppShell";
import { ComplianceMatrix } from "@/components/compliance/ComplianceMatrix";
import { CompliancePosture } from "@/components/compliance/CompliancePosture";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  COMPLIANCE_LABELS,
  STATUS_LABELS,
  type ComplianceStatus,
  type Vendor,
} from "@/data/contracts";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { RequestDocumentsAction } from "@/features/vendors/RequestDocumentsAction";

const statusRank: Record<ComplianceStatus, number> = {
  expired: 5,
  missing: 4,
  pending: 3,
  expiring: 2,
  compliant: 0,
};

function primaryException(vendor: Vendor) {
  return [...vendor.compliance]
    .filter((item) => item.status !== "compliant")
    .sort((a, b) => statusRank[b.status] - statusRank[a.status])[0];
}

export function OverviewPage() {
  const repo = getRepository();
  const metrics = useQuery({ queryKey: ["metrics"], queryFn: () => repo.listOverviewMetrics() });
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => repo.listVendors() });
  const [selectedVendorId, setSelectedVendorId] = useState<string>();
  const attention = useMemo(
    () =>
      (vendors.data ?? [])
        .filter(primaryException)
        .sort(
          (a, b) =>
            statusRank[primaryException(b)?.status ?? "compliant"] -
            statusRank[primaryException(a)?.status ?? "compliant"],
        ),
    [vendors.data],
  );
  const selectedVendor = attention.find((vendor) => vendor.id === selectedVendorId) ?? attention[0];
  const selectedException = selectedVendor ? primaryException(selectedVendor) : undefined;
  const posture = useMemo(() => {
    const items = (vendors.data ?? []).flatMap((vendor) => vendor.compliance);
    return [
      {
        id: "urgent",
        label: "Urgent",
        value: items.filter((item) => item.status === "missing" || item.status === "expired")
          .length,
        detail: "Requirements blocking action",
        tone: "danger" as const,
      },
      {
        id: "expiring",
        label: "Expiring",
        value: items.filter((item) => item.status === "expiring" || item.status === "pending")
          .length,
        detail: "Due soon or in review",
        tone: "warn" as const,
      },
      {
        id: "clear",
        label: "Clear",
        value: items.filter((item) => item.status === "compliant").length,
        detail: "Requirements currently met",
        tone: "ok" as const,
      },
    ];
  }, [vendors.data]);

  return (
    <AppShell
      title="Command center"
      subtitle="The exceptions most likely to hold up vendor approval, ranked for action."
    >
      <div className="space-y-7">
        <section aria-labelledby="metrics-heading">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2
                id="metrics-heading"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                Current position
              </h2>
            </div>
            <p className="hidden max-w-sm text-right text-xs text-muted-foreground sm:block">
              Counts reflect the latest submitted vendor documentation in this demo workspace.
            </p>
          </div>
          {metrics.isLoading ? (
            <div className="mt-4">
              <LoadingState label="Loading program metrics" rows={2} />
            </div>
          ) : metrics.isError ? (
            <div className="mt-4">
              <ErrorState
                description="Demo metrics failed to load."
                onRetry={() => void metrics.refetch()}
              />
            </div>
          ) : (
            <dl className="mt-4 grid divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
              {(metrics.data ?? []).map((metric) => (
                <div key={metric.id} className="py-4 sm:px-4 sm:first:pl-0 xl:py-5">
                  <dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {metric.label}
                  </dt>
                  <dd className="numeric mt-2 text-3xl font-semibold tracking-tight text-foreground">
                    {metric.value}
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">{metric.detail}</p>
                </div>
              ))}
            </dl>
          )}
        </section>

        {vendors.data ? (
          <CompliancePosture
            label="Compliance posture"
            summary={`${posture.reduce((total, segment) => total + segment.value, 0)} requirements tracked`}
            segments={posture}
          />
        ) : null}

        <section aria-labelledby="attention-heading">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2
                id="attention-heading"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                Needs action now
              </h2>
            </div>
            <Link
              to="/dashboard/vendors"
              className="focusable text-sm font-semibold text-primary underline underline-offset-4"
            >
              View vendor register
            </Link>
          </div>
          {vendors.isLoading ? (
            <div className="mt-4">
              <LoadingState label="Loading vendor compliance" />
            </div>
          ) : vendors.isError ? (
            <div className="mt-4">
              <ErrorState
                description="Demo vendor list failed to load."
                onRetry={() => void vendors.refetch()}
              />
            </div>
          ) : attention.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                title="No exceptions open"
                description="Every tracked requirement is current across your roster."
              />
            </div>
          ) : (
            <div className="mt-4 grid gap-6 2xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="overflow-hidden border border-border bg-card shadow-[0_12px_28px_-24px_rgb(15_23_42/0.55)]">
                <div className="hidden grid-cols-[minmax(0,1fr)_9rem_22rem] gap-4 border-b border-border bg-muted/45 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:grid">
                  <span>Vendor and blocker</span>
                  <span>Priority</span>
                  <span>Compliance register</span>
                </div>
                {attention.map((vendor) => {
                  const exception = primaryException(vendor)!;
                  const active = vendor.id === selectedVendor?.id;
                  return (
                    <button
                      key={vendor.id}
                      type="button"
                      aria-label={`Inspect ${vendor.name}`}
                      onClick={() => setSelectedVendorId(vendor.id)}
                      className={`focusable grid w-full gap-2 border-b border-border px-4 py-4 text-left transition-colors last:border-b-0 xl:grid-cols-[minmax(0,1fr)_9rem_22rem] xl:items-center xl:gap-4 ${active ? "bg-primary/5" : "hover:bg-muted/70"}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-foreground">
                          {vendor.name}
                        </span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {vendor.trade} · {vendor.project}
                        </span>
                        <span className="mt-2 block text-sm text-foreground">
                          {COMPLIANCE_LABELS[exception.key]}{" "}
                          <span className="text-muted-foreground">
                            · {STATUS_LABELS[exception.status]}
                          </span>
                        </span>
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-destructive">
                        {exception.status}
                      </span>
                      <ComplianceMatrix
                        items={vendor.compliance}
                        vendorName={vendor.name}
                        className="mt-1 xl:mt-0"
                      />
                    </button>
                  );
                })}
              </div>
              {selectedVendor && selectedException ? (
                <aside
                  aria-label="Resolution inspector"
                  className="border border-border bg-card p-5 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.55)] 2xl:sticky 2xl:top-6 2xl:self-start"
                >
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">
                    Resolution inspector
                  </h2>
                  <div className="mt-5 border-y border-border py-4">
                    <p className="text-base font-semibold text-foreground">{selectedVendor.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selectedVendor.trade} · {selectedVendor.project}
                    </p>
                  </div>
                  <dl className="mt-5 space-y-4 text-sm">
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        Blocking item
                      </dt>
                      <dd className="mt-1 font-medium text-foreground">
                        {COMPLIANCE_LABELS[selectedException.key]}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        Current status
                      </dt>
                      <dd className="mt-1 font-medium capitalize text-destructive">
                        {STATUS_LABELS[selectedException.status]}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        Next action
                      </dt>
                      <dd className="mt-1 text-foreground">
                        Request a corrected submission and confirm the document is complete.
                      </dd>
                    </div>
                  </dl>
                  <Link
                    to="/dashboard/vendors/$vendorId"
                    params={{ vendorId: selectedVendor.id }}
                    className="focusable mt-6 inline-flex text-sm font-semibold text-primary underline underline-offset-4"
                  >
                    Open vendor record
                  </Link>
                  {isBackendConfigured() ? (
                    <RequestDocumentsAction vendorId={selectedVendor.id} />
                  ) : null}
                </aside>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
