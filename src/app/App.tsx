import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { DemoRole } from "@/data/contracts";
import type {
  CompanyActivationStatus,
  CompanyRole,
  CompanyServiceStatus,
} from "@/data/dbTypeAliases";
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
 *
 * `activation` is the same kind of affordance. It decides which screen the app
 * shows; it grants nothing. An unactivated account has no company, so RLS has
 * nothing to scope its reads to and every protected query comes back empty.
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
  /** The caller's first company membership, or null when they belong to none. */
  companyId: string | null;
  /**
   * The caller's role in that company. Presentation only - every write below is
   * re-checked by has_company_role() in RLS, which is the real boundary.
   */
  companyRole: CompanyRole | null;
  /**
   * Whether the caller's company's real console is open. "none" when they belong
   * to no company at all - the state a freshly signed-up account is in, which is
   * what the demo screen exists for.
   */
  activation: CompanyActivationStatus | "none";
  /**
   * Managed-service readiness of the caller's company. "live" once VendorClr has
   * validated the setup; "onboarding"/"in_review" means the post-checkout wizard
   * is still in progress. null when the caller belongs to no company. Decides
   * whether an activated account is routed to the onboarding wizard or the
   * console; grants nothing (RLS is the boundary).
   */
  serviceStatus: CompanyServiceStatus | null;
  /** True for VendorClr staff (platform_admins), who are never gated. */
  isStaff: boolean;
  /**
   * Re-runs the identity read. Nothing in the auth layer fires when access
   * changes underneath the session - a redemption creates a company, and an
   * admin's revoke closes one - so anything that does needs to call this.
   */
  refresh: () => void;
  userId: string | null;
  /** The signed-in user's own email, or null in demo mode / before load. Used to match an invited address — the real check is still server-side inside accept_company_invitation(). */
  email: string | null;
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
  companyId: null,
  companyRole: "owner",
  activation: "demo",
  serviceStatus: "live",
  isStaff: false,
  refresh: () => {},
  userId: null,
  email: null,
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
      companyId: null,
      companyRole: "owner" as CompanyRole,
      // The preview has no accounts at all, so there is nothing to activate.
      // "demo" here means "the sample sandbox"; AppShell only ever gates
      // sessions in live mode, so this value is descriptive, not load-bearing.
      activation: "demo" as CompanyActivationStatus,
      serviceStatus: "live" as CompanyServiceStatus,
      isStaff: false,
      refresh: () => {},
      userId: null,
      email: null,
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
  email: string;
  personName: string;
  companyName: string;
  companyId: string | null;
  companyRole: CompanyRole | null;
  activation: CompanyActivationStatus | "none";
  serviceStatus: CompanyServiceStatus | null;
  isPlatformAdmin: boolean;
}

/** Narrows the embedded companies row's service_status, failing closed to onboarding. */
function toServiceStatus(
  companyId: string | null,
  rawStatus: string | null | undefined,
): CompanyServiceStatus | null {
  if (!companyId) return null;
  if (rawStatus === "onboarding" || rawStatus === "in_review" || rawStatus === "live") {
    return rawStatus;
  }
  // Column missing (migration not applied) or embed failed: treat as "live" so a
  // pre-existing activated workspace is never pushed into an onboarding flow it
  // never had. New checkout companies always carry an explicit 'onboarding'.
  return "live";
}

/** Narrows whatever the embedded companies row carried, failing closed. */
function toActivation(
  companyId: string | null,
  rawStatus: string | null | undefined,
): CompanyActivationStatus | "none" {
  if (!companyId) return "none";
  if (rawStatus === "activated" || rawStatus === "revoked" || rawStatus === "demo") {
    return rawStatus;
  }
  // A membership whose company row came back without a usable activation_status
  // means either the column is not there yet (the migration has not been
  // applied) or the embed silently failed. Both read as "not open" rather than
  // "open", because guessing wrong here shows a customer a console they should
  // not have.
  return "demo";
}

function useLiveSessionValue(): Session {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [identity, setIdentity] = useState<LiveIdentity | null>(null);
  const [role, setRoleState] = useState<DemoRole>("customer");
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

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
          .select("company_id, role, companies ( name, activation_status, service_status )")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
        supabase.rpc("is_platform_admin"),
      ]);

      if (cancelled) return;

      const membership = membershipResult.data as {
        company_id?: string | null;
        role?: string | null;
        companies?: { name?: string; activation_status?: string; service_status?: string } | null;
      } | null;
      const company = membership?.companies;
      const companyId = membership?.company_id ?? null;

      setIdentity({
        userId,
        email,
        personName: profileResult.data?.full_name ?? profileResult.data?.email ?? email,
        companyName: company?.name ?? "No company yet",
        companyId,
        companyRole: (membership?.role as CompanyRole | undefined) ?? null,
        activation: toActivation(companyId, company?.activation_status),
        serviceStatus: toServiceStatus(companyId, company?.service_status),
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
  }, [reloadToken]);

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
      companyId: identity?.companyId ?? null,
      companyRole: identity?.companyRole ?? null,
      activation: identity?.activation ?? "none",
      serviceStatus: identity?.serviceStatus ?? null,
      isStaff: identity?.isPlatformAdmin === true,
      refresh,
      userId: identity?.userId ?? null,
      email: identity?.email ?? null,
      signOut,
    }),
    [status, role, canSwitchRole, identity, setRole, signOut, refresh],
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
