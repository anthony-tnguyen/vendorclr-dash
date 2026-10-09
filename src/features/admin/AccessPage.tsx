import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AdminGuard } from "./AdminGuard";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { AdminMember } from "@/data/contracts";
import type { CompanyRole } from "@/data/dbTypeAliases";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { ROLE_OPTIONS, roleLabel } from "@/features/team/roleOptions";

/**
 * Staff account management.
 *
 * Read-only until migration 20261009120000 added the platform-admin-gated RPCs
 * this screen drives: change a member's role, remove them, grant or revoke
 * super-admin, and send a password-reset link. Every mutation is re-checked by
 * is_platform_admin() in the database, so this UI is convenience, not the
 * boundary.
 *
 * Two groups: VendorClr staff (platform_admins — may belong to no company, so
 * they never show up under a company heading) and company members grouped by
 * company.
 */

const MUTATION_KEYS = [
  ["admin", "members"],
  ["admin", "staff"],
] as const;

function Banner({ message, kind }: { message: string; kind: "error" | "status" }) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={
        kind === "error"
          ? "rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
          : "rounded-sm border border-border bg-muted px-3 py-2 text-xs"
      }
    >
      {message}
    </p>
  );
}

function AccessConsole() {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const { userId } = useSession();

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grantEmail, setGrantEmail] = useState("");

  const members = useQuery({
    queryKey: ["admin", "members"],
    queryFn: () => repo.listAdminMembers(),
  });
  const staff = useQuery({
    queryKey: ["admin", "staff"],
    queryFn: () => repo.listPlatformAdmins(),
  });

  function invalidate() {
    for (const key of MUTATION_KEYS) void queryClient.invalidateQueries({ queryKey: key });
  }

  const beforeAction = () => {
    setNotice(null);
    setError(null);
  };
  const onActionError = (e: unknown) =>
    setError(e instanceof Error ? e.message : "That action could not be completed.");

  const setRole = useMutation({
    mutationFn: (v: { memberId: string; role: CompanyRole }) =>
      repo.setCompanyMemberRole(v.memberId, v.role),
    onMutate: beforeAction,
    onError: onActionError,
    onSuccess: () => {
      setNotice("Role updated.");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (v: { memberId: string; person: string }) => repo.removeCompanyMember(v.memberId),
    onMutate: beforeAction,
    onError: onActionError,
    onSuccess: (_data, v) => {
      setNotice(`Removed ${v.person}.`);
      invalidate();
    },
  });
  const setAdmin = useMutation({
    mutationFn: (v: { userId: string; enabled: boolean; person: string }) =>
      repo.setPlatformAdmin(v.userId, v.enabled),
    onMutate: beforeAction,
    onError: onActionError,
    onSuccess: (_data, v) => {
      setNotice(
        v.enabled ? `${v.person} is now a super admin.` : `Revoked ${v.person}'s super admin.`,
      );
      invalidate();
    },
  });
  const reset = useMutation({
    mutationFn: (v: { email: string }) => repo.sendPasswordReset(v.email),
    onMutate: beforeAction,
    onError: onActionError,
    onSuccess: (_data, v) => setNotice(`Password-reset link sent to ${v.email}.`),
  });
  const grant = useMutation({
    mutationFn: async (email: string) => {
      const found = await repo.findUserByEmail(email);
      if (!found) throw new Error(`No account found for ${email}.`);
      await repo.setPlatformAdmin(found.userId, true);
      return found;
    },
    onMutate: () => {
      setNotice(null);
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not grant super admin."),
    onSuccess: (found) => {
      setNotice(`${found.person} is now a super admin.`);
      setGrantEmail("");
      invalidate();
    },
  });

  function onGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = grantEmail.trim();
    if (email) grant.mutate(email);
  }

  if (members.isLoading || staff.isLoading) {
    return <LoadingState label="Loading accounts" rows={5} />;
  }
  if (members.isError || staff.isError) {
    return (
      <ErrorState
        description="Could not load accounts."
        onRetry={() => {
          void members.refetch();
          void staff.refetch();
        }}
      />
    );
  }

  const byCompany = new Map<string, AdminMember[]>();
  for (const m of members.data ?? []) {
    const list = byCompany.get(m.companyName) ?? [];
    list.push(m);
    byCompany.set(m.companyName, list);
  }
  const companies = [...byCompany.entries()].sort(([a], [b]) => a.localeCompare(b));
  const staffList = staff.data ?? [];

  return (
    <div className="space-y-8">
      {error ? <Banner kind="error" message={error} /> : null}
      {notice ? <Banner kind="status" message={notice} /> : null}

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-bold tracking-tight text-foreground">
            VendorClr staff (super admins){" "}
            <span className="numeric text-xs font-normal text-muted-foreground">
              ({staffList.length})
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Full cross-company access. You cannot revoke your own super-admin access.
          </p>
        </div>

        {staffList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No staff accounts yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-card">
            <table className="w-full min-w-[560px] text-left text-sm">
              <caption className="sr-only">VendorClr staff accounts</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Person
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {staffList.map((s) => {
                  const isSelf = s.userId === userId;
                  return (
                    <tr key={s.userId} className="border-b border-border last:border-0">
                      <th scope="row" className="px-3 py-3 font-medium">
                        {s.person}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {s.email}
                        </span>
                      </th>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={!s.email || reset.isPending}
                            onClick={() => reset.mutate({ email: s.email })}
                            className="focusable rounded-sm border border-input px-2 py-1 text-xs font-semibold disabled:opacity-50"
                          >
                            Send reset
                          </button>
                          <button
                            type="button"
                            disabled={isSelf || setAdmin.isPending}
                            title={
                              isSelf ? "You cannot revoke your own super-admin access." : undefined
                            }
                            onClick={() => {
                              if (window.confirm(`Revoke ${s.person}'s super-admin access?`)) {
                                setAdmin.mutate({
                                  userId: s.userId,
                                  enabled: false,
                                  person: s.person,
                                });
                              }
                            }}
                            className="focusable rounded-sm border border-destructive/40 px-2 py-1 text-xs font-semibold text-destructive disabled:opacity-40"
                          >
                            Revoke super admin
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <form
          onSubmit={onGrant}
          className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-4"
        >
          <div className="min-w-[16rem] flex-1">
            <label htmlFor="grant-email" className="block text-xs font-medium text-foreground">
              Grant super admin by email
            </label>
            <input
              id="grant-email"
              type="email"
              value={grantEmail}
              onChange={(e) => setGrantEmail(e.target.value)}
              placeholder="person@vendorclr.com"
              className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The person must already have an account (have signed in at least once).
            </p>
          </div>
          <button
            type="submit"
            disabled={grant.isPending || grantEmail.trim() === ""}
            className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {grant.isPending ? "Granting…" : "Grant"}
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-bold tracking-tight text-foreground">Company members</h2>
          <p className="text-xs text-muted-foreground">
            Change a role, remove a member, or send a password reset. A company always keeps at
            least one owner.
          </p>
        </div>

        {companies.length === 0 ? (
          <EmptyState title="No members" description="Customer accounts will appear here." />
        ) : (
          companies.map(([companyName, rows]) => (
            <div
              key={companyName}
              className="overflow-x-auto rounded-md border border-border bg-card"
            >
              <table className="w-full min-w-[720px] text-left text-sm">
                <caption className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {companyName}
                </caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
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
                    <th scope="col" className="px-3 py-2 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0 align-top">
                      <th scope="row" className="px-3 py-3 font-medium">
                        {m.person}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {m.email}
                        </span>
                        {m.isPlatformAdmin ? (
                          <span className="mt-1 inline-block rounded-sm border border-primary/30 bg-primary/[0.07] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                            Super admin
                          </span>
                        ) : null}
                      </th>
                      <td className="px-3 py-3">
                        <label className="sr-only" htmlFor={`role-${m.id}`}>
                          Role for {m.person}
                        </label>
                        <select
                          id={`role-${m.id}`}
                          value={m.role}
                          disabled={setRole.isPending}
                          onChange={(e) =>
                            setRole.mutate({ memberId: m.id, role: e.target.value as CompanyRole })
                          }
                          className="focusable rounded-sm border border-input bg-background px-2 py-1 text-xs disabled:opacity-50"
                        >
                          {ROLE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="numeric px-3 py-3 text-xs text-muted-foreground">
                        {m.lastActiveOn}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={!m.email || reset.isPending}
                            onClick={() => reset.mutate({ email: m.email })}
                            className="focusable rounded-sm border border-input px-2 py-1 text-xs font-semibold disabled:opacity-50"
                          >
                            Send reset
                          </button>
                          <button
                            type="button"
                            disabled={remove.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove ${m.person} (${roleLabel(m.role)}) from ${m.companyName}?`,
                                )
                              ) {
                                remove.mutate({ memberId: m.id, person: m.person });
                              }
                            }}
                            className="focusable rounded-sm border border-destructive/40 px-2 py-1 text-xs font-semibold text-destructive disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

export function AccessPage() {
  const isDemo = !isBackendConfigured();
  return (
    <AppShell
      title="Access management"
      subtitle={
        isDemo
          ? "Roles and accounts. Demo mode — changes are not persisted."
          : "Manage staff and company accounts: roles, removal, super-admin, and password resets."
      }
    >
      <AdminGuard>
        <AccessConsole />
      </AdminGuard>
    </AppShell>
  );
}
