import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSession } from "@/app/App";
import { useSignOut } from "@/app/useSignOut";
import { adminNav, customerNav, routes, type NavItem } from "@/app/router";
import { LoadingState } from "@/components/states/AsyncState";
import { SetupBanner } from "@/components/shell/SetupBanner";
import { LegalLinks } from "@/features/legal/LegalPages";
import { cn } from "@/lib/utils";
import logoAsset from "@/assets/vendorclr-logo.svg.asset.json";

type NavItems = readonly NavItem[];

// While staff act as a company, only the pages whose reads are scoped to the
// acting company are shown; the rest (projects, settings, team) are not yet
// acting-aware, so they are hidden to avoid showing a staff member every
// company's data under one company's banner.
const ACTING_NAV_LABELS = new Set(["Overview", "Vendors", "Tasks", "Reports", "Help"]);

// Requirement profiles is acting-aware (reads scope to the acting company, and
// staff writes are allowed by migration 20261010000200) but is not part of
// customerNav - customers reach it from Projects - so it is added explicitly to
// the acting nav, kept just before Help.
const ACTING_EXTRA_NAV: readonly NavItem[] = [
  {
    label: "Requirement profiles",
    to: routes.requirementProfiles,
    description: "Compliance rules for projects and vendors",
  },
];

function buildActingNav(baseNav: NavItems): NavItems {
  const result: NavItem[] = [];
  for (const item of baseNav) {
    if (!ACTING_NAV_LABELS.has(item.label)) continue;
    if (item.label === "Help") result.push(...ACTING_EXTRA_NAV);
    result.push(item);
  }
  return result;
}

function NavList({
  title,
  items,
  onNavigate,
}: {
  title: string;
  items: NavItems;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <div>
      <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">
        {title}
      </p>
      <ul className="mt-2 space-y-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              aria-label={`${item.label} — ${item.description}`}
              activeOptions={{
                exact:
                  (item.to as string) === "/dashboard" ||
                  (item.to as string) === "/dashboard/admin",
              }}
              activeProps={{
                className: "bg-sidebar-accent text-sidebar-foreground font-semibold",
                "aria-current": "page",
              }}
              onClick={onNavigate}
              className="focusable block rounded-sm px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SidebarContents({
  navigation,
  navigationTitle,
  role,
  onNavigate,
}: {
  navigation: NavItems;
  navigationTitle: string;
  role: "admin" | "customer";
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-4">
        <Link
          to="/dashboard"
          onClick={onNavigate}
          className="focusable"
          aria-label="VendorClr dashboard home"
        >
          <img src={logoAsset.url} alt="VendorClr" className="h-8 w-auto" />
        </Link>
        {role === "admin" ? (
          <span className="numeric rounded-sm border border-sidebar-border px-1.5 py-0.5 text-[10px] uppercase text-sidebar-foreground/70">
            ADMIN
          </span>
        ) : null}
      </div>
      <nav aria-label="Dashboard sections" className="space-y-4 px-1 pb-4">
        <NavList title={navigationTitle} items={navigation} onNavigate={onNavigate} />
      </nav>
      <div className="px-3 pb-6">
        <SessionPanel />
        <LegalLinks className="mt-4 flex gap-3 px-1 text-[11px] text-sidebar-foreground/70" />
      </div>
    </>
  );
}

function SessionPanel() {
  const { mode, canSwitchRole } = useSession();

  if (mode === "demo") return <DemoRoleSwitcher />;
  // Staff get the same switcher to preview the customer console; it is a view
  // toggle, not a privilege change - RLS decides what the database returns.
  return canSwitchRole ? <DemoRoleSwitcher /> : <SignedInPanel />;
}

function SignedInPanel() {
  const { personName, companyName } = useSession();
  const { signOut, error: signOutError } = useSignOut();

  return (
    <div className="rounded-sm border border-sidebar-border p-3">
      <p className="truncate text-xs font-semibold text-sidebar-foreground">{personName}</p>
      <p className="truncate text-[11px] text-sidebar-foreground/70">{companyName}</p>
      <button
        type="button"
        onClick={signOut}
        className="focusable mt-2 w-full rounded-sm border border-sidebar-border px-2 py-1.5 text-xs font-semibold text-sidebar-foreground"
      >
        Sign out
      </button>
      {signOutError ? (
        <p role="alert" className="mt-2 text-[11px] font-semibold text-destructive">
          {signOutError}
        </p>
      ) : null}
    </div>
  );
}

function DemoRoleSwitcher() {
  const { role, setRole, mode } = useSession();
  const isDemo = mode === "demo";

  return (
    <div className="rounded-sm border border-warn/40 bg-warn-soft p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-warn">
        {isDemo ? "Demo mode" : "Staff view"}
      </p>
      <p className="mt-1 text-xs text-foreground">
        {isDemo
          ? "Role preview only. This is not sign-in and grants no real access."
          : "Switches which console you see. Data access is enforced by the database."}
      </p>
      <fieldset className="mt-2">
        <legend className="sr-only">Choose demo role</legend>
        <div className="flex gap-1" role="group">
          {(["customer", "admin"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setRole(value)}
              aria-pressed={role === value}
              aria-label={`Preview as ${value === "admin" ? "administrator" : "customer"}`}
              className={cn(
                "focusable flex-1 rounded-sm border px-2 py-1.5 text-xs font-semibold",
                role === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-foreground",
              )}
            >
              {value === "admin" ? "Administrator" : "Customer"}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export interface AppShellProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function AppShell({ title, subtitle, actions, children }: AppShellProps) {
  const {
    personName,
    companyName,
    role,
    mode,
    status,
    activation,
    serviceStatus,
    isStaff,
    actingCompanyId,
    actingCompanyName,
    exitCompany,
  } = useSession();
  const { signOut } = useSignOut();
  const navigate = useNavigate();
  const acting = actingCompanyId != null;
  // The router's own location, not window.location - the latter lags behind a
  // client-side navigation and would send the wrong page back to sign-in.
  const here = useRouterState({ select: (state) => state.location.href });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const baseNav: NavItems = role === "admin" ? adminNav : customerNav;
  const navigation: NavItems = acting ? buildActingNav(baseNav) : baseNav;
  const navigationTitle = role === "admin" ? "Operations" : "Workspace";

  /**
   * The access gate for the whole console, placed in the chrome every dashboard
   * page renders through. Two hard redirects remain:
   *
   *   - signed out      -> /login (carrying the page asked for)
   *   - not activated    -> /demo  (no paid workspace yet)
   *
   * Managed-service readiness (service_status) is NO LONGER an access gate. A paid
   * customer whose setup is still onboarding / in review has full run of their
   * real dashboard; the only nudge is "wizard-first": a brand-new customer who has
   * not submitted yet (service_status 'onboarding'), landing on the dashboard
   * home, is sent to the wizard once. They can return to the dashboard freely, and
   * once submitted ('in_review') the home renders the dashboard with the setup
   * banner. Outbound actions are gated separately by service_status (ServiceGate +
   * the server-side trigger), not here.
   *
   * Not a security boundary: RLS is. An unactivated account has no company, so its
   * reads come back empty even if it reaches a page.
   */
  const signedOut = mode === "live" && status === "anonymous";
  const needsActivation =
    mode === "live" && status === "authenticated" && !isStaff && activation !== "activated";
  const activatedNotLive =
    mode === "live" &&
    status === "authenticated" &&
    !isStaff &&
    activation === "activated" &&
    serviceStatus !== null &&
    serviceStatus !== "live";
  // Wizard-first, but reachable: only the dashboard home nudges a not-yet-submitted
  // customer into the wizard. Every other route renders with the setup banner.
  const needsWizardFirst =
    activatedNotLive && serviceStatus === "onboarding" && pathname === "/dashboard";
  const showSetupBanner = activatedNotLive && serviceStatus !== null;

  // The destination is captured on first render and never recomputed: `here`
  // changes the moment the redirect lands, and re-running on it would send the
  // gate chasing its own navigation.
  const cameFrom = useRef(here);

  useEffect(() => {
    // Signed-out first: an anonymous visitor needs the sign-in screen, not the
    // demo screen, and carries the page they asked for so sign-in can return them.
    if (signedOut) {
      void navigate({
        to: "/login",
        search: { redirect: cameFrom.current },
        replace: true,
      });
      return;
    }
    if (needsActivation) {
      void navigate({ to: "/demo", replace: true });
      return;
    }
    if (needsWizardFirst) void navigate({ to: "/onboarding", replace: true });
  }, [signedOut, needsActivation, needsWizardFirst, navigate]);

  if (status === "loading" || signedOut || needsActivation || needsWizardFirst) {
    return (
      <div className="min-h-screen bg-background px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <LoadingState
            label={
              signedOut
                ? "Opening the sign-in screen"
                : needsActivation
                  ? "Opening the demo console"
                  : needsWizardFirst
                    ? "Opening your onboarding"
                    : "Loading your workspace"
            }
            rows={5}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        onClick={() => document.getElementById("main-content")?.focus()}
        className="focusable sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-card focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to main content
      </a>
      <div className="lg:flex">
        <aside className="hidden bg-sidebar text-sidebar-foreground lg:block lg:min-h-screen lg:w-64 lg:shrink-0">
          <SidebarContents navigation={navigation} navigationTitle={navigationTitle} role={role} />
        </aside>

        <div className="min-w-0 flex-1">
          <div className="border-b border-sidebar-border bg-sidebar text-sidebar-foreground lg:hidden">
            <div className="flex items-center justify-between px-4 py-3">
              <Link to="/dashboard" className="focusable" aria-label="VendorClr dashboard home">
                <img src={logoAsset.url} alt="VendorClr" className="h-8 w-auto" />
              </Link>
              <button
                type="button"
                onClick={() => setMobileNavOpen((open) => !open)}
                aria-expanded={mobileNavOpen}
                aria-controls="mobile-dashboard-navigation"
                aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
                className="focusable rounded-sm border border-sidebar-border px-3 py-1.5 text-xs font-semibold"
              >
                {mobileNavOpen ? "Close" : "Menu"}
              </button>
            </div>
            {mobileNavOpen ? (
              <div id="mobile-dashboard-navigation" className="border-t border-sidebar-border">
                <nav aria-label="Mobile dashboard sections" className="space-y-4 px-1 pt-3">
                  <NavList
                    title={navigationTitle}
                    items={navigation}
                    onNavigate={() => setMobileNavOpen(false)}
                  />
                </nav>
                <div className="px-3 pb-4">
                  <SessionPanel />
                </div>
              </div>
            ) : null}
          </div>
          <header className="border-b border-border bg-card px-4 py-4 sm:px-6">
            <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="text-lg font-bold tracking-tight text-foreground">{title}</h1>
                {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {actions}
                {mode === "demo" || (mode === "live" && status === "authenticated") ? (
                  <button
                    type="button"
                    // useSignOut ends the session (a no-op in the demo sandbox),
                    // clears cached queries and returns to the sign-in screen.
                    onClick={signOut}
                    className="focusable rounded-sm border border-input px-3 py-1.5 text-xs font-semibold text-foreground"
                  >
                    Sign out
                  </button>
                ) : null}
                <div className="rounded-sm border border-border px-2 py-1 text-right">
                  <p className="text-xs font-semibold text-foreground">{personName}</p>
                  <p className="text-[11px] text-muted-foreground">{companyName}</p>
                </div>
              </div>
            </div>
          </header>
          <main
            id="main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-[100rem] px-4 py-6 sm:px-6"
          >
            {acting ? (
              <div
                role="status"
                className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs"
              >
                <span className="font-semibold text-warn">
                  Acting as {actingCompanyName} — changes here affect this customer's workspace.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    exitCompany();
                    void navigate({ to: routes.adminCompanies });
                  }}
                  className="focusable rounded-sm border border-warn/50 px-2 py-1 font-semibold text-warn"
                >
                  Exit company
                </button>
              </div>
            ) : null}
            {showSetupBanner && serviceStatus !== null ? (
              <SetupBanner serviceStatus={serviceStatus} />
            ) : null}
            {children}
          </main>
          <footer className="border-t border-border px-4 py-4 text-xs text-muted-foreground sm:px-6">
            <div className="mx-auto w-full max-w-[100rem]">
              {mode === "demo"
                ? "Demo environment. Uploads, emails, reviews and exports are simulated in memory and are never persisted or sent."
                : "Vendor records, document upload, extraction, review and renewal email are all live."}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
