import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useSession } from "@/app/App";
import { routes } from "@/app/router";

/**
 * The one way to sign out of the console.
 *
 * `session.signOut()` only ends the Supabase session; on its own that leaves the
 * current page rendered with its cached, now-orphaned queries still on screen -
 * which is exactly the P0 that let a signed-out visitor keep editing onboarding.
 * This hook closes that gap: it ends the session, clears every cached query so no
 * other account's data can flash on the next sign-in, and navigates to /login.
 * A failure is surfaced through `error` rather than swallowed.
 *
 * Demo mode has no session to end (`signOut` is a no-op there), so this simply
 * returns the visitor to the sign-in screen - the same thing the old inline demo
 * handler did.
 */
export function useSignOut(): {
  signOut: () => void;
  pending: boolean;
  error: string | null;
} {
  const { signOut: endSession } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setError(null);
    setPending(true);
    void (async () => {
      try {
        await endSession();
        // Drop every cached query so a later sign-in never paints the previous
        // account's data, and anonymous pages have nothing stale to render.
        queryClient.clear();
        await navigate({ to: routes.login, replace: true });
      } catch (caught) {
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : "Could not sign out. Try again.",
        );
      } finally {
        setPending(false);
      }
    })();
  }, [endSession, queryClient, navigate]);

  return { signOut: run, pending, error };
}
