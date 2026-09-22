import { useState, type FormEvent } from "react";

import { inviteCompanyMember, type CompanyMemberRole } from "@/workflows/companyInvitations";
import { ROLE_OPTIONS } from "./roleOptions";

interface InviteMemberFormProps {
  companyId: string;
  onInvited: () => void;
}

const inputClass =
  "focusable w-full rounded-sm border border-input bg-card px-3 py-2 text-sm text-foreground";
const submitClass =
  "focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60";

type EmailStatus = "sent" | "failed" | "not_configured" | "suppressed";

function emailStatusMessage(email: string, status: EmailStatus): string {
  switch (status) {
    case "sent":
      return `Invitation emailed to ${email}.`;
    case "not_configured":
      return `Invitation created for ${email}. Email sending isn't configured yet — share the link below directly.`;
    case "suppressed":
      return `Invitation created for ${email}, but that address has opted out of email. Share the link below directly.`;
    case "failed":
      return `Invitation created for ${email}, but the email could not be sent. Share the link below directly.`;
  }
}

/**
 * Owner-only invite affordance. Always shows the acceptUrl inviteCompanyMember()
 * returns, even when the email sent successfully - the same graceful-degradation
 * link the workflow layer already builds for a not_configured/failed/suppressed
 * send, useful here for an owner who wants to share it another way (Slack, etc.)
 * regardless of send status.
 */
export function InviteMemberForm({ companyId, onInvited }: InviteMemberFormProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CompanyMemberRole>("read_only");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    setAcceptUrl(null);
    try {
      const result = await inviteCompanyMember({ data: { companyId, email, role } });
      setNotice(emailStatusMessage(result.email.to, result.email.status));
      setAcceptUrl(result.acceptUrl);
      setEmail("");
      setRole("read_only");
      onInvited();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send the invitation. Try again.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">Invite a teammate</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1 space-y-1.5">
          <label htmlFor="invite-email" className="block text-xs font-medium text-foreground">
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            disabled={pending}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="invite-role" className="block text-xs font-medium text-foreground">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            disabled={pending}
            onChange={(event) => setRole(event.target.value as CompanyMemberRole)}
            className="focusable rounded-sm border border-input bg-card px-2 py-2 text-sm"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "Sending…" : "Send invitation"}
        </button>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <div role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
          <p>{notice}</p>
          {acceptUrl ? (
            <p className="mt-1 break-all">
              Invitation link:{" "}
              <a href={acceptUrl} className="font-medium text-primary underline">
                {acceptUrl}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
