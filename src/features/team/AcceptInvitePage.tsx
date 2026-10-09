import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { useSession } from "@/app/App";
import { routes } from "@/app/router";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  acceptCompanyInvitation,
  previewCompanyInvitation,
  INVITATION_TTL_DAYS,
} from "@/workflows/companyInvitations";
import { LegalConsent } from "@/features/legal/LegalPages";
import { roleLabel } from "./roleOptions";
import logoAsset from "@/assets/vendorclr-logo.svg.asset.json";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <img src={logoAsset.url} alt="VendorClr" className="h-8 w-auto" />
        <div className="mt-3 rounded-md border border-border bg-card p-6">{children}</div>
      </div>
    </div>
  );
}

/**
 * Every state a teammate can land in from the emailed invitation link.
 *
 * previewCompanyInvitation() only returns null for a token that matches no
 * row at all (never existed, or was guessed) - a real invitation, whatever
 * its status, always comes back with its actual status. That is the anti-
 * enumeration line: guessing narrows nothing (uniform null), but holding
 * the real token from a real email already told you it exists, so the
 * specific expired/revoked/accepted copy below leaks nothing new.
 */
export function AcceptInvitePage({ token }: { token: string }) {
  const navigate = useNavigate();
  const session = useSession();
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["invitation-preview", token],
    queryFn: () => previewCompanyInvitation({ data: { token } }),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => acceptCompanyInvitation({ data: { token } }),
    onError: (cause) =>
      setAcceptError(
        cause instanceof Error ? cause.message : "This invitation is no longer valid.",
      ),
  });

  if (preview.isLoading) {
    return (
      <Shell>
        <LoadingState label="Loading your invitation" rows={2} />
      </Shell>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <Shell>
        <ErrorState
          title="This invitation link isn't valid"
          description="It may have been mistyped, or the invitation no longer exists. Ask whoever invited you to send a new one."
        />
      </Shell>
    );
  }

  const invite = preview.data;

  if (invite.status === "revoked") {
    return (
      <Shell>
        <ErrorState
          title="This invitation was revoked"
          description={`Whoever invited you to ${invite.companyName} has withdrawn this invitation. Ask them for a new one if this was unexpected.`}
        />
      </Shell>
    );
  }

  if (invite.status === "expired") {
    return (
      <Shell>
        <ErrorState
          title="This invitation has expired"
          description={`Invitations to join ${invite.companyName} expire after ${INVITATION_TTL_DAYS} days. Ask whoever invited you to send a new one.`}
        />
      </Shell>
    );
  }

  if (invite.status === "accepted") {
    return (
      <Shell>
        <ErrorState
          title="This invitation was already used"
          description={`This invitation to join ${invite.companyName} has already been accepted. Sign in to your account instead.`}
        />
      </Shell>
    );
  }

  if (accept.isSuccess) {
    return (
      <Shell>
        <h1 className="text-lg font-bold tracking-tight text-foreground">
          You've joined {invite.companyName}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You're in as {roleLabel(accept.data.role)}.
        </p>
        <button
          type="button"
          onClick={() => void navigate({ to: routes.dashboard })}
          className="focusable mt-4 w-full rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          Go to your dashboard
        </button>
      </Shell>
    );
  }

  if (session.status !== "authenticated") {
    const redirect = `/accept-invite/${token}`;
    return (
      <Shell>
        <h1 className="text-lg font-bold tracking-tight text-foreground">
          Join {invite.companyName} on VendorClr
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in with <span className="font-medium text-foreground">{invite.email}</span> to accept
          this invitation as {roleLabel(invite.role)}.
        </p>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link
            to="/login"
            search={{ redirect }}
            className="focusable rounded-sm bg-primary px-3 py-2 font-semibold text-primary-foreground"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            search={{ redirect }}
            className="focusable rounded-sm border border-input bg-card px-3 py-2 font-semibold text-foreground"
          >
            Create an account
          </Link>
        </div>
      </Shell>
    );
  }

  const sessionEmail = session.email?.trim().toLowerCase() ?? null;
  const inviteEmail = invite.email.trim().toLowerCase();

  if (sessionEmail !== inviteEmail) {
    return (
      <Shell>
        <h1 className="text-lg font-bold tracking-tight text-foreground">
          This invitation isn't for this account
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This invitation was sent to a different email address. Sign out and sign back in with the
          address it was sent to, then open the link again.
        </p>
        <button
          type="button"
          onClick={() => void session.signOut()}
          className="focusable mt-4 rounded-sm border border-input bg-card px-3 py-2 text-sm font-semibold text-foreground"
        >
          Sign out
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-lg font-bold tracking-tight text-foreground">
        Join {invite.companyName} on VendorClr
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        You're signed in as {invite.email}. Accept to join as {roleLabel(invite.role)}.
      </p>
      {acceptError ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {acceptError}
        </p>
      ) : null}
      <button
        type="button"
        disabled={accept.isPending}
        onClick={() => accept.mutate()}
        className="focusable mt-4 w-full rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        {accept.isPending ? "Joining…" : "Accept invitation"}
      </button>
      <LegalConsent
        action="accepting this invitation"
        className="mt-3 text-xs leading-5 text-muted-foreground"
      />
    </Shell>
  );
}
