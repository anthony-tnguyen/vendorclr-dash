import { useQuery } from "@tanstack/react-query";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";

export function LeadsPage() {
  const repo = getRepository();
  const leads = useQuery({ queryKey: ["leads"], queryFn: () => repo.listLeads() });

  return (
    <AppShell title="Leads" subtitle="Inbound interest from contractors and owners.">
      <AdminGuard>
        {leads.isLoading ? (
          <LoadingState label="Loading leads" rows={4} />
        ) : leads.isError ? (
          <ErrorState
            description="Demo lead list failed to load."
            onRetry={() => void leads.refetch()}
          />
        ) : (leads.data ?? []).length === 0 ? (
          <EmptyState title="No leads yet" description="New inbound leads will appear here." />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full min-w-[640px] text-left text-sm">
              <caption className="sr-only">Inbound leads</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Company</th>
                  <th scope="col" className="px-3 py-2 font-medium">Contact</th>
                  <th scope="col" className="px-3 py-2 font-medium">Trade</th>
                  <th scope="col" className="px-3 py-2 font-medium">Source</th>
                  <th scope="col" className="px-3 py-2 font-medium">Created</th>
                  <th scope="col" className="px-3 py-2 font-medium">Stage</th>
                </tr>
              </thead>
              <tbody>
                {(leads.data ?? []).map((lead) => (
                  <tr key={lead.id} className="border-b border-border last:border-0">
                    <th scope="row" className="px-3 py-3 font-medium">{lead.company}</th>
                    <td className="px-3 py-3 text-xs">{lead.contact}</td>
                    <td className="px-3 py-3 text-xs">{lead.trade}</td>
                    <td className="px-3 py-3 text-xs">{lead.source}</td>
                    <td className="numeric px-3 py-3 text-xs">{lead.createdOn}</td>
                    <td className="px-3 py-3 text-xs uppercase">{lead.stage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
