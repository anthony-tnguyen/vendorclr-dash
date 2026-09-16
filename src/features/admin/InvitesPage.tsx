import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AdminGuard } from "./AdminGuard";
import { InviteForm } from "./InviteForm";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";

export function InvitesPage() {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const invites = useQuery({
    queryKey: ["signup-invites"],
    queryFn: () => repo.listSignupInvites(),
  });

  const revoke = useMutation({
    mutationFn: (inviteId: string) => repo.revokeSignupInvite(inviteId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["signup-invites"] });
    },
  });

  return (
    <AppShell
      title="Signup invites"
      subtitle="Admin-issued codes that gate self-serve business signup."
      actions={
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          aria-expanded={showForm}
          className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          {showForm ? "Close invite form" : "Create invite"}
        </button>
      }
    >
      <AdminGuard>
        <div className="space-y-4">
          {showForm ? <InviteForm onDone={() => setShowForm(false)} /> : null}

          {revoke.isError ? (
            <p
              role="alert"
              className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
            >
              {revoke.error instanceof Error
                ? revoke.error.message
                : "Could not revoke the invite."}
            </p>
          ) : null}

          {invites.isLoading ? (
            <LoadingState label="Loading signup invites" rows={4} />
          ) : invites.isError ? (
            <ErrorState
              description="Signup invite list failed to load."
              onRetry={() => void invites.refetch()}
            />
          ) : (invites.data ?? []).length === 0 ? (
            <EmptyState
              title="No signup invites"
              description="Create an invite to let a new company sign up."
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full min-w-[720px] text-left text-sm">
                <caption className="sr-only">Signup invites by company</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Company
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Email
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Code
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Expires
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(invites.data ?? []).map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-0">
                      <th scope="row" className="px-3 py-3 font-medium">
                        {invite.companyName}
                      </th>
                      <td className="px-3 py-3 text-xs">{invite.email}</td>
                      <td className="px-3 py-3 text-xs font-mono">{invite.code}</td>
                      <td className="px-3 py-3 text-xs uppercase">{invite.status}</td>
                      <td className="numeric px-3 py-3 text-xs">{invite.expiresOn}</td>
                      <td className="px-3 py-3 text-right text-xs">
                        {invite.status === "pending" ? (
                          <button
                            type="button"
                            onClick={() => revoke.mutate(invite.id)}
                            disabled={revoke.isPending && revoke.variables === invite.id}
                            aria-label={`Revoke invite for ${invite.companyName}`}
                            className="focusable rounded-sm border border-border px-2 py-1 text-xs font-medium disabled:opacity-60"
                          >
                            Revoke
                          </button>
                        ) : null}
                      </td>
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
