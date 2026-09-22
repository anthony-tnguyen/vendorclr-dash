import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { isBackendConfigured } from "@/data/repository";
import {
  changeCompanyMemberRole,
  listCompanyMembers,
  removeCompanyMember,
  transferCompanyOwnership,
  type CompanyMemberRole,
  type CompanyMemberSummary,
} from "@/workflows/companyInvitations";
// import { InviteMemberForm } from "./InviteMemberForm";
// import { PendingInvitationsTable } from "./PendingInvitationsTable";
import { ROLE_OPTIONS, roleLabel } from "./roleOptions";

/**
 * Who is on this company's workspace, and what each person may do.
 *
 * Every mutation goes through a SECURITY DEFINER function that re-checks the
 * caller is an owner of the member's company, and the database refuses to leave
 * a company with no active owner - so hiding the controls from non-owners below
 * is presentation, not the security boundary.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

const buttonClass =
  "focusable rounded-sm border border-input bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-60";

export function TeamPage() {
  const { companyId, companyRole, userId, mode } = useSession();
  const queryClient = useQueryClient();
  const live = isBackendConfigured() && mode === "live";
  const isOwner = companyRole === "owner";
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ["team", companyId],
    enabled: live && Boolean(companyId),
    queryFn: () => listCompanyMembers({ data: { companyId: companyId as string } }),
  });

  const finish = (message: string) => {
    setError(null);
    setNotice(message);
    void queryClient.invalidateQueries({ queryKey: ["team", companyId] });
  };
  const fail = (cause: unknown) => {
    setNotice(null);
    setError(errorMessage(cause));
  };

  const changeRole = useMutation({
    mutationFn: (input: { member: CompanyMemberSummary; newRole: CompanyMemberRole }) =>
      changeCompanyMemberRole({ data: { memberId: input.member.id, newRole: input.newRole } }),
    onSuccess: (_row, input) =>
      finish(`${input.member.email ?? "Member"} is now ${roleLabel(input.newRole)}.`),
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (member: CompanyMemberSummary) =>
      removeCompanyMember({ data: { memberId: member.id } }),
    onSuccess: (_result, member) => finish(`${member.email ?? "Member"} no longer has access.`),
    onError: fail,
  });

  const transfer = useMutation({
    mutationFn: (input: { from: CompanyMemberSummary; to: CompanyMemberSummary }) =>
      transferCompanyOwnership({
        data: { fromMemberId: input.from.id, toMemberId: input.to.id, demotedRole: "risk_manager" },
      }),
    onSuccess: (_result, input) =>
      finish(`${input.to.email ?? "Member"} is now the owner. You are now a risk manager.`),
    onError: fail,
  });

  const busy = changeRole.isPending || remove.isPending || transfer.isPending;
  const active = (members.data ?? []).filter((member) => member.isActive);
  const removed = (members.data ?? []).filter((member) => !member.isActive);
  const me = active.find((member) => member.userId === userId) ?? null;

  return (
    <AppShell
      title="Team"
      subtitle={
        live
          ? "Who has access to this workspace, and what each person can do."
          : "Sample console — team changes are not available without a live workspace."
      }
    >
      <div className="space-y-4">
        {!live ? (
          <EmptyState
            title="No live workspace"
            description="Team management works on a real, activated workspace. This preview has no members to change."
          />
        ) : !companyId ? (
          <EmptyState
            title="No workspace yet"
            description="Enter an activation code to open your workspace, then manage your team here."
          />
        ) : members.isLoading ? (
          <LoadingState label="Loading team" rows={3} />
        ) : members.isError ? (
          <ErrorState
            title="Could not load your team"
            description={errorMessage(members.error)}
            onRetry={() => void members.refetch()}
          />
        ) : (
          <>
            {!isOwner ? (
              <p role="note" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                Only an owner can change roles or remove people. You can see who is on the team.
              </p>
            ) : null}
            {error ? (
              <p
                role="alert"
                className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
              >
                {error}
              </p>
            ) : null}
            {notice ? (
              <p
                role="status"
                className="rounded-sm border border-border bg-muted px-3 py-2 text-xs"
              >
                {notice}
              </p>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Team members and their roles</caption>
                <thead className="border-b border-border bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Person
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Role
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Last active
                    </th>
                    {isOwner ? (
                      <th scope="col" className="px-3 py-2 font-medium">
                        Actions
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {active.map((member) => {
                    const isMe = member.userId === userId;
                    return (
                      <tr key={member.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2">
                          <span className="font-medium">{member.email ?? "Unknown user"}</span>
                          {isMe ? (
                            <span className="ml-2 text-xs text-muted-foreground">you</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">
                          {isOwner ? (
                            <select
                              aria-label={`Role for ${member.email ?? "member"}`}
                              value={member.role}
                              disabled={busy}
                              onChange={(event) =>
                                changeRole.mutate({
                                  member,
                                  newRole: event.target.value as CompanyMemberRole,
                                })
                              }
                              className="focusable rounded-sm border border-input bg-card px-2 py-1 text-sm"
                            >
                              {ROLE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            roleLabel(member.role)
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {member.lastActiveAt ? member.lastActiveAt.slice(0, 10) : "Never"}
                        </td>
                        {isOwner ? (
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-2">
                              {me && !isMe && member.role !== "owner" ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  className={buttonClass}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        `Make ${member.email ?? "this person"} the owner? You will become a risk manager.`,
                                      )
                                    ) {
                                      transfer.mutate({ from: me, to: member });
                                    }
                                  }}
                                >
                                  Make owner
                                </button>
                              ) : null}
                              <button
                                type="button"
                                disabled={busy}
                                className={buttonClass}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Remove ${member.email ?? "this person"}? They lose access to this workspace immediately.`,
                                    )
                                  ) {
                                    remove.mutate(member);
                                  }
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              {ROLE_OPTIONS.map((option) => (
                <div key={option.value}>
                  <dt className="inline font-semibold text-foreground">{option.label}: </dt>
                  <dd className="inline">{option.blurb}</dd>
                </div>
              ))}
            </dl>

            {removed.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Removed: {removed.map((member) => member.email ?? "unknown").join(", ")}
              </p>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
