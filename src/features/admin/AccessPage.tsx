import { useQuery } from "@tanstack/react-query";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository, isBackendConfigured } from "@/data/repository";

export function AccessPage() {
  const repo = getRepository();
  const isDemo = !isBackendConfigured();
  const grants = useQuery({ queryKey: ["access"], queryFn: () => repo.listAccessGrants() });

  return (
    <AppShell
      title="Access management"
      subtitle={
        isDemo
          ? "Roles and project scopes. Demo mode — changes are not persisted."
          : "Roles and project scopes. Invite teammates from a company's own Team page."
      }
    >
      <AdminGuard>
        <div className="space-y-4">
          {grants.isLoading ? (
            <LoadingState label="Loading access grants" rows={4} />
          ) : grants.isError ? (
            <ErrorState
              description="Could not load access grants."
              onRetry={() => void grants.refetch()}
            />
          ) : (grants.data ?? []).length === 0 ? (
            <EmptyState title="No access grants" description="No one has access recorded yet." />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Access grants by person</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Person
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Role
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Scope
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Last active
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(grants.data ?? []).map((grant) => (
                    <tr key={grant.id} className="border-b border-border last:border-0">
                      <th scope="row" className="px-3 py-3 font-medium">
                        {grant.person}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {grant.email}
                        </span>
                      </th>
                      <td className="px-3 py-3 text-xs">{grant.role}</td>
                      <td className="px-3 py-3 text-xs">{grant.scope}</td>
                      <td className="numeric px-3 py-3 text-xs">{grant.lastActiveOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </AdminGuard>
    </AppShell>
  );
}
