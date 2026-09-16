import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { CompliancePosture } from "@/components/compliance/CompliancePosture";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { QueueItem } from "@/data/contracts";
import { getRepository, isBackendConfigured } from "@/data/repository";

const queueRank: Record<QueueItem["state"], number> = {
  escalated: 4,
  "in-review": 3,
  queued: 2,
  resolved: 0,
};

export function AdminOverviewPage() {
  const repo = getRepository();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => repo.listCompanies() });
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => repo.listQueue() });
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [notice, setNotice] = useState<string | null>(null);
  const activeQueue = useMemo(
    () =>
      [...(queue.data ?? [])]
        .filter((item) => item.state !== "resolved")
        .sort((a, b) => queueRank[b.state] - queueRank[a.state]),
    [queue.data],
  );
  const selectedItem = activeQueue.find((item) => item.id === selectedItemId) ?? activeQueue[0];

  const totals = {
    companies: companies.data?.length ?? 0,
    vendors: (companies.data ?? []).reduce((sum, c) => sum + c.vendors, 0),
    queue: queue.data?.length ?? 0,
    escalated: (queue.data ?? []).filter((q) => q.state === "escalated").length,
  };
  const reviewPosture = [
    {
      id: "escalated",
      label: "Escalated",
      value: (queue.data ?? []).filter((item) => item.state === "escalated").length,
      detail: "Needs reviewer attention",
      tone: "danger" as const,
    },
    {
      id: "in-review",
      label: "In review",
      value: (queue.data ?? []).filter(
        (item) => item.state === "in-review" || item.state === "queued",
      ).length,
      detail: "Awaiting a decision",
      tone: "warn" as const,
    },
    {
      id: "resolved",
      label: "Resolved",
      value: (queue.data ?? []).filter((item) => item.state === "resolved").length,
      detail: "Decisions completed",
      tone: "ok" as const,
    },
  ];

  return (
    <AppShell
      title="Command center"
      subtitle="The document decisions that need a reviewer before vendor work can continue."
    >
      <AdminGuard>
        {companies.isLoading || queue.isLoading ? (
          <LoadingState label="Loading platform metrics" rows={3} />
        ) : companies.isError || queue.isError ? (
          <ErrorState
            description="Demo administrator data failed to load."
            onRetry={() => {
              void companies.refetch();
              void queue.refetch();
            }}
          />
        ) : (
          <div className="space-y-7">
            {notice ? (
              <p
                role="status"
                className="rounded-sm border border-border bg-muted px-3 py-2 text-xs"
              >
                {notice}
              </p>
            ) : null}
            <section aria-labelledby="admin-metrics-heading">
              <h2
                id="admin-metrics-heading"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                Review capacity
              </h2>
              <dl className="mt-4 grid divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
                {[
                  {
                    label: "Customer companies",
                    value: totals.companies,
                    detail: "Active accounts",
                  },
                  { label: "Vendors under management", value: totals.vendors, detail: "All plans" },
                  { label: "Documents in queue", value: totals.queue, detail: "Awaiting review" },
                  { label: "Escalated", value: totals.escalated, detail: "Needs a reviewer today" },
                ].map((item) => (
                  <div key={item.label} className="py-4 sm:px-4 sm:first:pl-0 xl:py-5">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {item.label}
                    </dt>
                    <dd className="numeric mt-2 text-3xl font-semibold tracking-tight">
                      {item.value}
                    </dd>
                    <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                  </div>
                ))}
              </dl>
            </section>

            <CompliancePosture
              label="Review posture"
              summary={`${reviewPosture.reduce((total, segment) => total + segment.value, 0)} documents tracked`}
              segments={reviewPosture}
            />

            <section aria-labelledby="review-queue-heading">
              <div>
                <h2
                  id="review-queue-heading"
                  className="text-lg font-semibold tracking-tight text-foreground"
                >
                  Queue requiring review
                </h2>
              </div>
              {activeQueue.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="Queue is clear"
                    description="No vendor documents are waiting for review."
                  />
                </div>
              ) : (
                <div className="mt-4 grid gap-6 2xl:grid-cols-[minmax(0,1fr)_22rem]">
                  <div className="overflow-hidden border border-border bg-card shadow-[0_12px_28px_-24px_rgb(15_23_42/0.55)]">
                    <div className="hidden grid-cols-[minmax(0,1fr)_8rem_8rem] gap-4 border-b border-border bg-muted/45 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground md:grid">
                      <span>Document and vendor</span>
                      <span>State</span>
                      <span>Submitted</span>
                    </div>
                    {activeQueue.map((item) => {
                      const active = item.id === selectedItem?.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-label={`Inspect ${item.document} from ${item.vendorName}`}
                          onClick={() => setSelectedItemId(item.id)}
                          className={`focusable grid w-full gap-2 border-b border-border px-4 py-4 text-left transition-colors last:border-b-0 md:grid-cols-[minmax(0,1fr)_8rem_8rem] md:items-center md:gap-4 ${active ? "bg-primary/5" : "hover:bg-muted/70"}`}
                        >
                          <span>
                            <span className="block text-sm font-semibold text-foreground">
                              {item.document}
                            </span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {item.vendorName} · {item.company}
                            </span>
                          </span>
                          <span
                            className={`text-xs font-semibold uppercase tracking-[0.12em] ${item.state === "escalated" ? "text-destructive" : "text-foreground"}`}
                          >
                            {item.state}
                          </span>
                          <span className="numeric text-xs text-muted-foreground">
                            {item.submittedOn}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {selectedItem ? (
                    <aside
                      aria-label="Review inspector"
                      className="border border-border bg-card p-5 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.55)] 2xl:sticky 2xl:top-6 2xl:self-start"
                    >
                      <h2 className="text-lg font-semibold tracking-tight text-foreground">
                        Review inspector
                      </h2>
                      <div className="mt-5 border-y border-border py-4">
                        <p className="text-base font-semibold text-foreground">
                          {selectedItem.document}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {selectedItem.vendorName} · {selectedItem.company}
                        </p>
                      </div>
                      <dl className="mt-5 space-y-4 text-sm">
                        <div>
                          <dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                            Review state
                          </dt>
                          <dd className="mt-1 font-medium capitalize text-foreground">
                            {selectedItem.state}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                            Submitted
                          </dt>
                          <dd className="numeric mt-1 text-foreground">
                            {selectedItem.submittedOn}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                            Recommended next action
                          </dt>
                          <dd className="mt-1 text-foreground">
                            Verify coverage details, then resolve or return the document with the
                            missing requirement.
                          </dd>
                        </div>
                      </dl>
                      {isBackendConfigured() && selectedItem.documentId ? (
                        <Link
                          to="/dashboard/admin/compliance/$queueItemId"
                          params={{ queueItemId: selectedItem.id }}
                          aria-label={`Open review for ${selectedItem.document} from ${selectedItem.vendorName}`}
                          className="focusable mt-6 inline-flex rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                        >
                          Open review
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setNotice(
                              "Demo mode: review is unavailable because no document has been stored.",
                            )
                          }
                          aria-label={`Open review for ${selectedItem.document} from ${selectedItem.vendorName}`}
                          className="focusable mt-6 inline-flex rounded-sm border border-border px-3 py-2 text-xs font-semibold"
                        >
                          Open review (demo)
                        </button>
                      )}
                    </aside>
                  ) : null}
                </div>
              )}
            </section>
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
