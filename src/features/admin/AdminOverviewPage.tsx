import { useQuery } from "@tanstack/react-query";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { ErrorState, LoadingState, StateGallery } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";

export function AdminOverviewPage() {
  const repo = getRepository();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => repo.listCompanies() });
  const queue = useQuery({ queryKey: ["queue"], queryFn: () => repo.listQueue() });

  const totals = {
    companies: companies.data?.length ?? 0,
    vendors: (companies.data ?? []).reduce((sum, c) => sum + c.vendors, 0),
    queue: queue.data?.length ?? 0,
    escalated: (queue.data ?? []).filter((q) => q.state === "escalated").length,
  };

  return (
    <AppShell title="Administrator overview" subtitle="Platform operations across all customers.">
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
          <div className="space-y-6">
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "Customer companies", value: totals.companies, detail: "Active accounts" },
                { label: "Vendors under management", value: totals.vendors, detail: "All plans" },
                { label: "Documents in queue", value: totals.queue, detail: "Awaiting review" },
                { label: "Escalated", value: totals.escalated, detail: "Needs a reviewer today" },
              ].map((item) => (
                <div key={item.label} className="rounded-md border border-border bg-card p-4">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {item.label}
                  </dt>
                  <dd className="numeric mt-1 text-2xl font-semibold">{item.value}</dd>
                  <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                </div>
              ))}
            </dl>
            <StateGallery />
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
