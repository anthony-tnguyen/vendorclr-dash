import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";

export function ComplianceQueuePage() {
  const repo = getRepository();
  const [notice, setNotice] = useState<string | null>(null);
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => repo.listQueue() });

  return (
    <AppShell
      title="Compliance queue"
      subtitle="Documents submitted by vendors awaiting reviewer action."
    >
      <AdminGuard>
        <div className="space-y-4">
          {notice ? (
            <p role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
              {notice}
            </p>
          ) : null}

          {queue.isLoading ? (
            <LoadingState label="Loading review queue" rows={4} />
          ) : queue.isError ? (
            <ErrorState
              description="Demo review queue failed to load."
              onRetry={() => void queue.refetch()}
            />
          ) : (queue.data ?? []).length === 0 ? (
            <EmptyState
              title="Queue is clear"
              description="No vendor documents are waiting for review."
            />
          ) : (
            <ul className="space-y-2">
              {(queue.data ?? []).map((item) => (
                <li
                  key={item.id}
                  className="rounded-md border border-border bg-card p-3 sm:flex sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{item.document}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.vendorName} · {item.company}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 sm:mt-0">
                    <span className="numeric text-xs text-muted-foreground">{item.submittedOn}</span>
                    <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] uppercase">
                      {item.state}
                    </span>
                    <button
                      type="button"
                      aria-label={`Open review for ${item.document} from ${item.vendorName}`}
                      onClick={() =>
                        setNotice(
                          "Demo mode: no review was recorded and no notification was sent.",
                        )
                      }
                      className="focusable rounded-sm border border-border px-2 py-1 text-xs font-medium"
                    >
                      Review (demo)
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </AdminGuard>
    </AppShell>
  );
}
