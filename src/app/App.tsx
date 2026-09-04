import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { DemoRole } from "@/data/contracts";
import { getSupabaseClient } from "@/lib/supabase/client";
import { hasBackendEnv } from "@/lib/supabase/env";

/**
 * Session context.
 *
 * Two modes, chosen by whether Supabase is configured:
 *
 *   "demo" - the original presentation-layer role switcher. Not authentication,
 *            grants nothing, and every screen says so.
 *   "live" - a real Supabase session. `role` reflects platform_admins membership
 *            rather than a toggle, and identity comes from profiles/companies.
 *
 * Note what `role` is NOT: an authorization boundary. Hiding admin routes is a
 * convenience. The actual boundary is RLS in supabase/migrations - a user who
 * forces their way to /dashboard/admin still gets nothing back from the database.
 */

export type SessionMode = "demo" | "live";
export type SessionStatus = "loading" | "authenticated" | "anonymous";

export interface Session {
  mode: SessionMode;
  status: SessionStatus;
  role: DemoRole;
  /** No-op unless the signed-in user is VendorClr staff. */
  setRole: (role: DemoRole) => void;
  canSwitchRole: boolean;
  personName: string;
  companyName: string;
  userId: string | null;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

const DEMO_FALLBACK: Session = {
  mode: "demo",
  status: "authenticated",
  role: "customer",
  setRole: () => {},
  canSwitchRole: true,
  personName: "Rosa Sandoval",
  companyName: "Halstead Builders",
  userId: null,
  signOut: async () => {},
};

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

function useDemoSessionValue(): Session {
  const [role, setRole] = useState<DemoRole>("customer");

  return useMemo(
    () => ({
      mode: "demo",
      status: "authenticated",
      role,
      setRole,
      canSwitchRole: true,
      personName: role === "admin" ? "VendorClr Operations" : "Rosa Sandoval",
      companyName: role === "admin" ? "VendorClr Internal" : "Halstead Builders",
      userId: null,
      signOut: async () => {},
    }),
    [role],
  );
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

interface LiveIdentity {
  userId: string;
  personName: string;
  companyName: string;
  isPlatformAdmin: boolean;
}

function useLiveSessionValue(): Session {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [identity, setIdentity] = useState<LiveIdentity | null>(null);
  const [role, setRoleState] = useState<DemoRole>("customer");

  useEffect(() => {
    const supabase = getSupabaseClient();
    let cancelled = false;

    async function loadIdentity(userId: string, email: string) {
      // Three independent reads; RLS scopes each one. Run them together rather
      // than waterfalling - this is on the critical path for first paint.
      const [profileResult, membershipResult, adminResult] = await Promise.all([
        supabase.from("profiles").select("full_name, email").eq("id", userId).maybeSingle(),
        supabase
          .from("company_members")
          .select("companies ( name )")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabase.rpc("is_platform_admin"),
      ]);

      if (cancelled) return;

      const company = (membershipResult.data as { companies?: { name?: string } | null } | null)
        ?.companies;

      setIdentity({
        userId,
        personName: profileResult.data?.full_name ?? profileResult.data?.email ?? email,
        companyName: company?.name ?? "No company yet",
        isPlatformAdmin: adminResult.data === true,
      });
      setStatus("authenticated");
    }

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const user = data.session?.user;
      if (!user) {
        setStatus("anonymous");
        setIdentity(null);
        return;
      }
      void loadIdentity(user.id, user.email ?? "");
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      const user = session?.user;
      if (!user) {
        setStatus("anonymous");
        setIdentity(null);
        setRoleState("customer");
        return;
      }
      void loadIdentity(user.id, user.email ?? "");
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const canSwitchRole = identity?.isPlatformAdmin === true;

  const setRole = useCallback(
    (next: DemoRole) => {
      // Staff can preview the customer console. Everyone else is pinned; the
      // database would refuse the admin reads anyway.
      if (!canSwitchRole) return;
      setRoleState(next);
    },
    [canSwitchRole],
  );

  const signOut = useCallback(async () => {
    await getSupabaseClient().auth.signOut();
  }, []);

  return useMemo(
    () => ({
      mode: "live",
      status,
      role: canSwitchRole ? role : "customer",
      setRole,
      canSwitchRole,
      personName: identity?.personName ?? "",
      companyName: identity?.companyName ?? "",
      userId: identity?.userId ?? null,
      signOut,
    }),
    [status, role, canSwitchRole, identity, setRole, signOut],
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function DemoSessionProvider({ children }: { children: ReactNode }) {
  const value = useDemoSessionValue();
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function LiveSessionProvider({ children }: { children: ReactNode }) {
  const value = useLiveSessionValue();
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function App({ children }: { children: ReactNode }) {
  // hasBackendEnv() reads build-time env, so this never flips between renders and
  // the differing hook order between the two providers is safe.
  return hasBackendEnv() ? (
    <LiveSessionProvider>{children}</LiveSessionProvider>
  ) : (
    <DemoSessionProvider>{children}</DemoSessionProvider>
  );
}

export function useSession(): Session {
  // Safe default so isolated component tests do not need the provider.
  return useContext(SessionContext) ?? DEMO_FALLBACK;
}

/** @deprecated Use useSession(). Kept so existing call sites keep compiling. */
export const useDemoSession = useSession;
