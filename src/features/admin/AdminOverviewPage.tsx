import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { QueueItem } from "@/data/contracts";
import { getRepository } from "@/data/repository";

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
          <div className="space-y-8">
            <section aria-labelledby="admin-metrics-heading">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Portfolio signal
              </p>
              <h2 id="admin-metrics-heading" className="mt-1 text-lg font-semibold text-foreground">
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

            <section aria-labelledby="review-queue-heading">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Review queue
                </p>
                <h2
                  id="review-queue-heading"
                  className="mt-1 text-lg font-semibold text-foreground"
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
                <div className="mt-4 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
                  <div className="border-y border-border">
                    <div className="hidden grid-cols-[minmax(0,1fr)_8rem_8rem] gap-4 border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground md:grid">
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
                      className="border border-border bg-card p-5 xl:sticky xl:top-6 xl:self-start"
                    >
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Selected submission
                      </p>
                      <h2 className="mt-2 text-lg font-semibold text-foreground">
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
