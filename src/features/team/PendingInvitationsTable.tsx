import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  listCompanyInvitations,
  resendCompanyInvitation,
  revokeCompanyInvitation,
  type CompanyInvitation,
} from "@/workflows/companyInvitations";
import { roleLabel } from "./roleOptions";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

const buttonClass =
  "focusable rounded-sm border border-input bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-60";

const STATUS_LABEL: Record<CompanyInvitation["status"], string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};

/**
 * Owner-only. Resend/revoke only render for a row whose *computed* status
 * (expiry-aware, from listCompanyInvitations()) is genuinely 'pending' -
 * expired, revoked and accepted rows are display-only, so a dead link never
 * looks actionable.
 */
export function PendingInvitationsTable({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invitations = useQuery({
    queryKey: ["team-invitations", companyId],
    queryFn: () => listCompanyInvitations({ data: { companyId } }),
  });

  const finish = (message: string) => {
    setError(null);
    setNotice(message);
    void queryClient.invalidateQueries({ queryKey: ["team-invitations", companyId] });
  };
  const fail = (cause: unknown) => {
    setNotice(null);
    setError(errorMessage(cause));
  };

  const resend = useMutation({
    mutationFn: (invitation: CompanyInvitation) =>
      resendCompanyInvitation({ data: { invitationId: invitation.id } }),
    onSuccess: (_result, invitation) => finish(`Invitation resent to ${invitation.email}.`),
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: (invitation: CompanyInvitation) =>
      revokeCompanyInvitation({ data: { invitationId: invitation.id } }),
    onSuccess: (_result, invitation) => finish(`Invitation to ${invitation.email} was revoked.`),
    onError: fail,
  });

  const busy = resend.isPending || revoke.isPending;
  const rows = invitations.data ?? [];

  if (invitations.isLoading) {
    return <LoadingState label="Loading pending invitations" rows={2} />;
  }
  if (invitations.isError) {
    return (
      <ErrorState
        title="Could not load pending invitations"
        description={errorMessage(invitations.error)}
        onRetry={() => void invitations.refetch()}
      />
    );
  }
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">Pending invitations</h2>
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Pending and past invitations</caption>
          <thead className="border-b border-border bg-muted text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Email
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Role
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Invited by
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Sent
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Expires
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((invitation) => (
              <tr key={invitation.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-medium">{invitation.email}</td>
                <td className="px-3 py-2">{roleLabel(invitation.role)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {invitation.invitedByEmail ?? "Unknown"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {invitation.createdAt.slice(0, 10)}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {invitation.expiresAt.slice(0, 10)}
                </td>
                <td className="px-3 py-2 text-xs">{STATUS_LABEL[invitation.status]}</td>
                <td className="px-3 py-2">
                  {invitation.status === "pending" ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass}
                        onClick={() => resend.mutate(invitation)}
                      >
                        Resend
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass}
                        onClick={() => {
                          if (window.confirm(`Revoke the invitation to ${invitation.email}?`)) {
                            revoke.mutate(invitation);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
