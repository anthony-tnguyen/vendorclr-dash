import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { useSession } from "@/app/App";
import { routes } from "@/app/router";
import { LoadingState } from "@/components/states/AsyncState";

/**
 * Anonymous-route guard for the standalone pages that render outside AppShell -
 * onboarding and checkout. AppShell already gates the dashboard; these pages had
 * no equivalent, so after a sign-out they stayed rendered and interactive with a
 * now-anonymous session (the P0).
 *
 * While the session is still resolving, or once it is anonymous, the children are
 * not mounted at all - which also means their queries never fire against a
 * session that has no company to be scoped to. An anonymous visitor is sent to
 * /login carrying the page they asked for, so sign-in can return them.
 *
 * Demo mode (no backend configured) is always "authenticated", so the preview is
 * never gated.
 */
export function RequireAuth({
  children,
  loadingLabel = "Loading your workspace",
}: {
  children: ReactNode;
  loadingLabel?: string;
}) {
  const { mode, status } = useSession();
  const navigate = useNavigate();
  // The router's own location, captured once: it changes the instant the redirect
  // lands, so recomputing it would send the guard chasing its own navigation.
  const here = useRouterState({ select: (state) => state.location.href });
  const cameFrom = useRef(here);

  const signedOut = mode === "live" && status === "anonymous";

  useEffect(() => {
    if (signedOut) {
      void navigate({ to: routes.login, search: { redirect: cameFrom.current }, replace: true });
    }
  }, [signedOut, navigate]);

  if (status === "loading" || signedOut) {
    return (
      <div className="min-h-screen bg-background px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <LoadingState
            label={signedOut ? "Opening the sign-in screen" : loadingLabel}
            rows={5}
          />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
