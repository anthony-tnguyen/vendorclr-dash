import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDemoSession } from "@/app/App";
import { adminNav, customerNav } from "@/app/router";
import { cn } from "@/lib/utils";

function NavList({ title, items }: { title: string; items: typeof customerNav }) {
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
              activeOptions={{ exact: item.to === "/dashboard" || item.to === "/dashboard/admin" }}
              activeProps={{
                className: "bg-sidebar-accent text-sidebar-foreground font-semibold",
                "aria-current": "page",
              }}
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

function DemoRoleSwitcher() {
  const { role, setRole } = useDemoSession();

  return (
    <div className="rounded-sm border border-warn/40 bg-warn-soft p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-warn">Demo mode</p>
      <p className="mt-1 text-xs text-foreground">
        Role preview only. This is not sign-in and grants no real access.
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
  const { personName, companyName, role } = useDemoSession();

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        className="focusable sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-card focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to main content
      </a>
      <div className="lg:flex">
        <aside className="bg-sidebar text-sidebar-foreground lg:min-h-screen lg:w-64 lg:shrink-0">
          <div className="flex items-center justify-between px-4 py-4">
            <Link
              to="/dashboard"
              className="focusable text-sm font-bold tracking-tight text-sidebar-foreground"
              aria-label="VendorClear dashboard home"
            >
              VendorClear
            </Link>
            <span className="numeric rounded-sm border border-sidebar-border px-1.5 py-0.5 text-[10px] uppercase text-sidebar-foreground/70">
              {role === "admin" ? "ADMIN" : "CUSTOMER"}
            </span>
          </div>
          <nav aria-label="Dashboard sections" className="space-y-4 px-1 pb-4">
            <NavList title="Customer" items={customerNav} />
            <NavList title="Administrator" items={adminNav} />
          </nav>
          <div className="px-3 pb-6">
            <DemoRoleSwitcher />
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="border-b border-border bg-card px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="text-lg font-bold tracking-tight text-foreground">{title}</h1>
                {subtitle ? (
                  <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {actions}
                <div className="rounded-sm border border-border px-2 py-1 text-right">
                  <p className="text-xs font-semibold text-foreground">{personName}</p>
                  <p className="text-[11px] text-muted-foreground">{companyName}</p>
                </div>
              </div>
            </div>
          </header>
          <main id="main-content" className="px-4 py-6 sm:px-6">
            {children}
          </main>
          <footer className="border-t border-border px-4 py-4 text-xs text-muted-foreground sm:px-6">
            Demo environment. Uploads, emails, reviews and exports are simulated in memory and are
            never persisted or sent.
          </footer>
        </div>
      </div>
    </div>
  );
}
