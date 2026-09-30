import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSession } from "@/app/App";
import { adminNav, customerNav } from "@/app/router";
import { LoadingState } from "@/components/states/AsyncState";
import { LegalLinks } from "@/features/legal/LegalPages";
import { cn } from "@/lib/utils";

type NavItems = typeof customerNav | typeof adminNav;

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
          <img src="/vendorclr-logo-white.svg" alt="VendorClr" className="h-5 w-auto" />
        </Link>
        <span className="numeric rounded-sm border border-sidebar-border px-1.5 py-0.5 text-[10px] uppercase text-sidebar-foreground/70">
          {role === "admin" ? "ADMIN" : "CUSTOMER"}
        </span>
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
  const { personName, companyName, signOut } = useSession();

  return (
    <div className="rounded-sm border border-sidebar-border p-3">
      <p className="truncate text-xs font-semibold text-sidebar-foreground">{personName}</p>
      <p className="truncate text-[11px] text-sidebar-foreground/70">{companyName}</p>
      <button
        type="button"
        onClick={() => void signOut()}
        className="focusable mt-2 w-full rounded-sm border border-sidebar-border px-2 py-1.5 text-xs font-semibold text-sidebar-foreground"
      >
        Sign out
      </button>
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
  const { personName, companyName, role, mode, status, activation, serviceStatus, isStaff, signOut } =
    useSession();
  const navigate = useNavigate();
  // The router's own location, not window.location - the latter lags behind a
  // client-side navigation and would send the wrong page back to sign-in.
  const here = useRouterState({ select: (state) => state.location.href });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navigation = role === "admin" ? adminNav : customerNav;
  const navigationTitle = role === "admin" ? "Operations" : "Workspace";

  /**
   * The one access gate for the whole console, placed in the chrome every
   * dashboard page renders through so no page has to remember to check access
   * itself - and, because nothing below <AppShell /> mounts until it passes, no
   * page's queries fire against a session that has not been resolved or an
   * account that has no company to be scoped to.
   *
   * Not a security boundary: RLS is. An unactivated account has no company, so
   * its reads come back empty even if it reaches a page.
   *
   * Demo mode is the preview sandbox rather than a session, and staff may hold
   * no company membership at all, so neither is gated.
   */
  const signedOut = mode === "live" && status === "anonymous";
  const needsActivation =
    mode === "live" && status === "authenticated" && !isStaff && activation !== "activated";
  // An activated (paid) account whose managed-service setup is not yet live
  // belongs in the onboarding wizard, not the console. Staff are never gated;
  // 'live' (and pre-existing/activation-code companies, which are 'live') pass.
  // The vendor importers are part of onboarding's Vendors step, so an onboarding
  // account must be allowed to reach them even though they live in the gated
  // console chrome; every other console page still bounces to the wizard.
  const onOnboardingImporter =
    here.includes("/dashboard/vendors/coi-import") || here.includes("/dashboard/vendors/import");
  const needsOnboarding =
    mode === "live" &&
    status === "authenticated" &&
    !isStaff &&
    activation === "activated" &&
    serviceStatus !== null &&
    serviceStatus !== "live" &&
    !onOnboardingImporter;

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
    if (needsOnboarding) void navigate({ to: "/onboarding", replace: true });
  }, [signedOut, needsActivation, needsOnboarding, navigate]);

  if (status === "loading" || signedOut || needsActivation || needsOnboarding) {
    return (
      <div className="min-h-screen bg-background px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <LoadingState
            label={
              signedOut
                ? "Opening the sign-in screen"
                : needsActivation
                  ? "Opening the demo console"
                  : needsOnboarding
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
                <img src="/vendorclr-logo-white.svg" alt="VendorClr" className="h-5 w-auto" />
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
                {mode === "live" && status === "authenticated" ? (
                  <button
                    type="button"
                    onClick={() => void signOut()}
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
