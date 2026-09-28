import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpFromLine, ChevronRight, FilePlus2 } from "lucide-react";
import { StatusIcon, statusIconStyles } from "@/components/compliance/statusVisuals";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  STATUS_LABELS,
  type ComplianceItem,
  type ComplianceKey,
  type ComplianceStatus,
  type Vendor,
} from "@/data/contracts";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { cn } from "@/lib/utils";

const statusRank: Record<ComplianceStatus, number> = {
  expired: 5,
  missing: 4,
  pending: 3,
  expiring: 2,
  compliant: 0,
};

const overviewRequirementLabels: Record<ComplianceKey, string> = {
  coi: "Certificate of insurance",
  additionalInsured: "Additional insured",
  waiverOfSubrogation: "Waiver of subrogation",
  lienWaiver: "Lien waiver",
  renewal: "Renewal",
};

const complianceOrder: ComplianceKey[] = [
  "coi",
  "additionalInsured",
  "waiverOfSubrogation",
  "lienWaiver",
  "renewal",
];

type AttentionFilter = "action" | "expiring" | "pending";

const filterConfig: Array<{
  id: AttentionFilter;
  label: string;
  statuses: ComplianceStatus[];
  dotClass: string;
}> = [
  {
    id: "action",
    label: "Action needed",
    statuses: ["missing", "expired"],
    dotClass: "bg-destructive",
  },
  { id: "expiring", label: "Expiring soon", statuses: ["expiring"], dotClass: "bg-warn" },
  { id: "pending", label: "Pending review", statuses: ["pending"], dotClass: "bg-primary" },
];

function primaryException(vendor: Vendor) {
  return [...vendor.compliance]
    .filter((item) => item.status !== "compliant")
    .sort((a, b) => statusRank[b.status] - statusRank[a.status])[0];
}

function filterException(vendor: Vendor, filter: AttentionFilter) {
  const statuses = filterConfig.find((item) => item.id === filter)?.statuses ?? [];
  return [...vendor.compliance]
    .filter((item) => statuses.includes(item.status))
    .sort((a, b) => statusRank[b.status] - statusRank[a.status])[0];
}

function formatDate(value: string | null) {
  if (!value) return "No date on file";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function statusTextClass(status: ComplianceStatus) {
  if (status === "compliant") return "text-ok";
  if (status === "expiring") return "text-warn";
  if (status === "pending") return "text-primary";
  return "text-destructive";
}

function ComplianceStatusCell({ item }: { item: ComplianceItem }) {
  const description = `${overviewRequirementLabels[item.key]}: ${STATUS_LABELS[item.status]}, ${formatDate(item.effectiveDate)}`;
  return (
    <div role="status" aria-label={description} title={description} className="min-w-28">
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-semibold",
          statusTextClass(item.status),
        )}
      >
        <StatusIcon status={item.status} className={statusIconStyles[item.status]} />
        {STATUS_LABELS[item.status]}
      </p>
      <p className="numeric mt-1 pl-5 text-[10px] text-muted-foreground">
        {formatDate(item.effectiveDate)}
      </p>
    </div>
  );
}

export function OverviewPage() {
  const repo = getRepository();
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => repo.listVendors() });
  const [filter, setFilter] = useState<AttentionFilter>("action");
  const [selectedVendorId, setSelectedVendorId] = useState<string>();

  const allVendors = useMemo(() => vendors.data ?? [], [vendors.data]);
  const allAttention = useMemo(
    () =>
      allVendors
        .filter(primaryException)
        .sort(
          (a, b) =>
            statusRank[primaryException(b)?.status ?? "compliant"] -
            statusRank[primaryException(a)?.status ?? "compliant"],
        ),
    [allVendors],
  );
  const attention = useMemo(
    () =>
      allVendors
        .filter((vendor) => filterException(vendor, filter))
        .sort(
          (a, b) =>
            statusRank[filterException(b, filter)?.status ?? "compliant"] -
            statusRank[filterException(a, filter)?.status ?? "compliant"],
        ),
    [allVendors, filter],
  );
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        filterConfig.map(({ id, statuses }) => [
          id,
          allVendors.filter((vendor) =>
            vendor.compliance.some((item) => statuses.includes(item.status)),
          ).length,
        ]),
      ) as Record<AttentionFilter, number>,
    [allVendors],
  );
  const selectedVendor = attention.find((vendor) => vendor.id === selectedVendorId) ?? attention[0];
  const selectedException = selectedVendor ? filterException(selectedVendor, filter) : undefined;
  const activeProjectCount = new Set(allAttention.map((vendor) => vendor.project)).size;
  const expiringRequirementCount = allVendors
    .flatMap((vendor) => vendor.compliance)
    .filter((item) => item.status === "expiring").length;
  const subtitle = vendors.isLoading
    ? "Loading compliance priorities across active projects."
    : `${allAttention.length} vendors need resolution across ${activeProjectCount} active ${activeProjectCount === 1 ? "project" : "projects"} · ${expiringRequirementCount} ${expiringRequirementCount === 1 ? "requirement expires" : "requirements expire"} soon`;

  return (
    <AppShell
      title="Compliance overview"
      subtitle={subtitle}
      actions={
        <div className="flex flex-wrap gap-2">
          <Link
            to="/dashboard/vendors/import"
            className="focusable inline-flex items-center gap-2 rounded-sm border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
          >
            <ArrowUpFromLine aria-hidden="true" className="size-4" />
            Import vendors
          </Link>
          {isBackendConfigured() && selectedVendor ? (
            <Link
              to="/dashboard/vendors/$vendorId"
              params={{ vendorId: selectedVendor.id }}
              hash="communications-heading"
              className="focusable inline-flex items-center gap-2 rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
            >
              <FilePlus2 aria-hidden="true" className="size-4" />
              Request documents
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2" aria-label="Compliance filters">
          {filterConfig.map((item) => {
            const active = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                aria-label={`Show ${item.label.toLowerCase()}`}
                onClick={() => setFilter(item.id)}
                className={cn(
                  "focusable inline-flex items-center gap-2 rounded-sm border px-3 py-2 text-xs font-semibold transition-colors",
                  active
                    ? "border-primary/35 bg-primary/5 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-muted",
                )}
              >
                <span aria-hidden="true" className={cn("size-2 rounded-full", item.dotClass)} />
                {item.label}
                <span className="numeric text-[10px] text-muted-foreground">
                  {filterCounts[item.id]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <section
            aria-labelledby="attention-heading"
            className="min-w-0 rounded-md border border-border bg-card p-4 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.45)] sm:p-5 xl:col-start-1 xl:row-start-1"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  id="attention-heading"
                  className="text-lg font-semibold tracking-tight text-foreground"
                >
                  Needs attention
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {filterConfig.find((item) => item.id === filter)?.label} items, ordered by
                  urgency.
                </p>
              </div>
              <Link
                to="/dashboard/vendors"
                className="focusable inline-flex items-center gap-1 text-xs font-semibold text-primary underline underline-offset-4"
              >
                View vendor register
                <ChevronRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>

            {vendors.isLoading ? (
              <div className="mt-4">
                <LoadingState label="Loading vendor compliance" />
              </div>
            ) : vendors.isError ? (
              <div className="mt-4">
                <ErrorState
                  description="Vendor compliance failed to load."
                  onRetry={() => void vendors.refetch()}
                />
              </div>
            ) : attention.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title={`No ${filterConfig.find((item) => item.id === filter)?.label.toLowerCase()} items`}
                  description="Choose another status to review the rest of the compliance queue."
                />
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-sm border border-border">
                <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
                  <thead className="bg-muted/55 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 font-semibold">Vendor</th>
                      <th className="px-3 py-2.5 font-semibold">Issue</th>
                      <th className="px-3 py-2.5 font-semibold">Project</th>
                      <th className="px-3 py-2.5 font-semibold">Next step</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.map((vendor) => {
                      const exception = filterException(vendor, filter)!;
                      const active = vendor.id === selectedVendor?.id;
                      return (
                        <tr
                          key={vendor.id}
                          className={cn("border-t border-border", active && "bg-primary/5")}
                        >
                          <td className="px-3 py-3 align-top">
                            <Link
                              to="/dashboard/vendors/$vendorId"
                              params={{ vendorId: vendor.id }}
                              className="focusable font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-primary"
                            >
                              {vendor.name}
                            </Link>
                            <p className="mt-1 text-xs text-muted-foreground">{vendor.trade}</p>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <p className="flex items-center gap-2 font-medium text-foreground">
                              <StatusIcon
                                status={exception.status}
                                className={statusIconStyles[exception.status]}
                              />
                              {overviewRequirementLabels[exception.key]}
                            </p>
                            <p
                              className={cn(
                                "mt-1 pl-5 text-xs font-semibold",
                                statusTextClass(exception.status),
                              )}
                            >
                              {STATUS_LABELS[exception.status]}
                            </p>
                          </td>
                          <td className="px-3 py-3 align-top text-muted-foreground">
                            {vendor.project}
                          </td>
                          <td className="px-3 py-3 align-top">
                            <button
                              type="button"
                              aria-label={`Inspect ${vendor.name}`}
                              onClick={() => setSelectedVendorId(vendor.id)}
                              className="focusable inline-flex items-center gap-1 text-xs font-semibold text-primary underline underline-offset-4"
                            >
                              Inspect details
                              <ChevronRight aria-hidden="true" className="size-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {selectedVendor && selectedException ? (
            <aside
              aria-label="Resolution inspector"
              className="rounded-md border border-border bg-card p-5 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.45)] xl:sticky xl:top-6 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-start"
            >
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                Resolution inspector
              </h2>
              <div className="mt-4 border-y border-border py-4">
                <p className="font-semibold text-foreground">{selectedVendor.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedVendor.trade} · {selectedVendor.project}
                </p>
              </div>
              <dl className="mt-4 space-y-4 text-sm">
                <div>
                  <dt className="text-xs font-semibold text-muted-foreground">Requirement</dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {overviewRequirementLabels[selectedException.key]}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted-foreground">Current status</dt>
                  <dd
                    className={cn("mt-1 font-semibold", statusTextClass(selectedException.status))}
                  >
                    {STATUS_LABELS[selectedException.status]}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted-foreground">Evidence</dt>
                  <dd className="mt-1 text-foreground">
                    {selectedException.note ?? formatDate(selectedException.effectiveDate)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold text-muted-foreground">Next action</dt>
                  <dd className="mt-1 text-foreground">
                    Open the vendor record to review evidence and confirm the appropriate follow-up.
                  </dd>
                </div>
              </dl>
              <Link
                to="/dashboard/vendors/$vendorId"
                params={{ vendorId: selectedVendor.id }}
                className="focusable mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary underline underline-offset-4"
              >
                Open vendor record
                <ChevronRight aria-hidden="true" className="size-4" />
              </Link>
              {isBackendConfigured() ? (
                <Link
                  to="/dashboard/vendors/$vendorId"
                  params={{ vendorId: selectedVendor.id }}
                  hash="communications-heading"
                  className="focusable mt-3 flex w-fit items-center gap-2 rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                >
                  <FilePlus2 aria-hidden="true" className="size-4" />
                  Prepare document request
                </Link>
              ) : null}
            </aside>
          ) : null}

          {vendors.data ? (
            <section
              aria-labelledby="vendor-compliance-heading"
              className="min-w-0 rounded-md border border-border bg-card p-4 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.45)] sm:p-5 xl:col-start-1 xl:row-start-2"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2
                    id="vendor-compliance-heading"
                    className="text-lg font-semibold tracking-tight text-foreground"
                  >
                    Vendor compliance
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Current requirement status across active vendor assignments.
                  </p>
                </div>
                <Link
                  to="/dashboard/vendors"
                  className="focusable inline-flex items-center gap-1 text-xs font-semibold text-primary underline underline-offset-4"
                >
                  View all vendors
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
              <div className="mt-4 overflow-x-auto rounded-sm border border-border">
                <table
                  aria-label="Vendor compliance"
                  className="w-full min-w-[72rem] border-collapse text-left"
                >
                  <thead className="bg-muted/55 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 font-semibold">Vendor</th>
                      {complianceOrder.map((key) => (
                        <th key={key} className="px-3 py-2.5 font-semibold">
                          {overviewRequirementLabels[key]}
                        </th>
                      ))}
                      <th className="px-3 py-2.5 font-semibold">Project</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allVendors.map((vendor) => (
                      <tr key={vendor.id} className="border-t border-border hover:bg-muted/35">
                        <td className="px-3 py-3 align-top">
                          <Link
                            to="/dashboard/vendors/$vendorId"
                            params={{ vendorId: vendor.id }}
                            className="focusable whitespace-nowrap text-sm font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-primary"
                          >
                            {vendor.name}
                          </Link>
                        </td>
                        {complianceOrder.map((key) => {
                          const item = vendor.compliance.find((entry) => entry.key === key) ?? {
                            key,
                            status: "missing" as const,
                            effectiveDate: null,
                          };
                          return (
                            <td key={key} className="px-3 py-3 align-top">
                              <ComplianceStatusCell item={item} />
                            </td>
                          );
                        })}
                        <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-muted-foreground">
                          {vendor.project}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
