import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";
import { planLabel } from "@/domain/billing/plans";
import { ActivationCodeForm } from "./ActivationCodeForm";
import { AdminGuard } from "./AdminGuard";

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * The switch that turns a signed-up demo account into a paid workspace.
 *
 * Codes are generated and redeemed by the database; this page only issues them,
 * lists them and withdraws the ones nobody has used. Revoking a code that was
 * already used does not close the workspace it opened - that is the Access
 * control on the same row, kept separate so "take this code away" and "take
 * this company away" are never the same click.
 */
export function ActivationCodesPage() {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const codes = useQuery({
    queryKey: ["activation-codes"],
    queryFn: () => repo.listActivationCodes(),
  });

  const revoke = useMutation({
    mutationFn: (codeId: string) => repo.revokeActivationCode(codeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["activation-codes"] });
    },
  });

  return (
    <AppShell
      title="Activation codes"
      subtitle="One email, one use. A code opens a workspace; it is not a login."
      actions={
        <button
          type="button"
          onClick={() => setShowForm((open) => !open)}
          aria-expanded={showForm}
          className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          {showForm ? "Close code form" : "Create code"}
        </button>
      }
    >
      <AdminGuard>
        <div className="space-y-4">
          {showForm ? <ActivationCodeForm onDone={() => setShowForm(false)} /> : null}

          {revoke.isError ? (
            <p
              role="alert"
              className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
            >
              {revoke.error instanceof Error
                ? revoke.error.message
                : "Could not withdraw that code."}
            </p>
          ) : null}

          {codes.isLoading ? (
            <LoadingState label="Loading activation codes" rows={4} />
          ) : codes.isError ? (
            <ErrorState
              description="Activation code list failed to load."
              onRetry={() => void codes.refetch()}
            />
          ) : (codes.data ?? []).length === 0 ? (
            <EmptyState
              title="No activation codes"
              description="Create a code for a customer who has signed up, and they can open their workspace themselves."
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full min-w-[900px] text-left text-sm">
                <caption className="sr-only">Activation codes by company</caption>
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
                      Plan
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Created
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Used
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(codes.data ?? []).map((code) => (
                    <tr key={code.id} className="border-b border-border last:border-0">
                      <th scope="row" className="px-3 py-3 font-medium">
                        {code.companyName}
                      </th>
                      <td className="px-3 py-3 text-xs">{code.email}</td>
                      <td className="numeric px-3 py-3 text-xs">{code.code}</td>
                      <td className="px-3 py-3 text-xs">{planLabel(code.plan)}</td>
                      <td className="px-3 py-3 text-xs uppercase">{code.status}</td>
                      <td className="numeric px-3 py-3 text-xs">{code.createdOn}</td>
                      <td className="numeric px-3 py-3 text-xs">{when(code.usedOn)}</td>
                      <td className="px-3 py-3 text-right text-xs">
                        {code.status === "pending" ? (
                          <button
                            type="button"
                            onClick={() => revoke.mutate(code.id)}
                            disabled={revoke.isPending && revoke.variables === code.id}
                            aria-label={`Withdraw the code for ${code.companyName}`}
                            className="focusable rounded-sm border border-border px-2 py-1 text-xs font-medium disabled:opacity-60"
                          >
                            Withdraw
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
