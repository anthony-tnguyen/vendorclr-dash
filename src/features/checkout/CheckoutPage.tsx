import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";

import { useSession } from "@/app/App";
import { routes } from "@/app/router";
import type { PlanId } from "@/domain/billing/plans";
import { PLANS, SELF_CHECKOUT_PLAN_IDS } from "@/domain/billing/plans";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { cn } from "@/lib/utils";
import logoAsset from "@/assets/vendorclr-logo.svg.asset.json";

/**
 * Plan selection + Stripe self-checkout. Shown to a signed-in account that has
 * no workspace yet. Choosing a plan calls the create-checkout Edge Function
 * (through the repository) and redirects to Stripe's hosted Checkout; the
 * webhook creates the company and drops the buyer into onboarding on return.
 */

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export function CheckoutPage() {
  const { status, mode, companyId, personName, signOut } = useSession();
  const search = useSearch({ strict: false }) as { plan?: string; canceled?: string };
  const live = isBackendConfigured();
  const preselected =
    search.plan && SELF_CHECKOUT_PLAN_IDS.includes(search.plan as PlanId)
      ? (search.plan as PlanId)
      : null;
  const [error, setError] = useState<string | null>(null);

  const checkout = useMutation({
    mutationFn: (plan: PlanId) => getRepository().createCheckoutSession(plan),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start checkout."),
  });

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <img src={logoAsset.url} alt="VendorClr" className="h-5 w-auto" />
          {status === "authenticated" && mode === "live" ? (
            <div className="flex items-center gap-3">
              {personName ? (
                <span className="truncate text-xs text-muted-foreground">{personName}</span>
              ) : null}
              <button
                type="button"
                onClick={() => void signOut()}
                className="focusable rounded-sm border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground"
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );

  if (mode === "live" && status === "anonymous") {
    return shell(
      <div className="rounded-md border border-border bg-card p-6">
        <h1 className="text-base font-bold text-foreground">Create an account to continue</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Checkout is tied to your VendorClr account. Create one or sign in, then choose a plan.
        </p>
        <div className="mt-4 flex gap-2">
          <Link
            to={routes.signup}
            className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            Create an account
          </Link>
          <Link
            to={routes.login}
            className="focusable rounded-sm border border-input bg-card px-3 py-2 text-sm font-semibold text-foreground"
          >
            Sign in
          </Link>
        </div>
      </div>,
    );
  }

  if (companyId) {
    return shell(
      <div className="rounded-md border border-border bg-card p-6">
        <h1 className="text-base font-bold text-foreground">You already have a workspace</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This account is already tied to a VendorClr workspace, so there&apos;s nothing to check
          out.
        </p>
        <Link
          to={routes.dashboard}
          className="focusable mt-4 inline-flex rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          Go to your workspace
        </Link>
      </div>,
    );
  }

  return shell(
    <>
      <div className="space-y-2">
        <h1 className="text-lg font-bold tracking-tight text-foreground">Choose your plan</h1>
        <p className="text-sm text-muted-foreground">
          Every plan includes the VendorClr dashboard, automated compliance workflows, and managed
          support. You&apos;ll set up your workspace right after checkout.
        </p>
      </div>

      {search.canceled ? (
        <p className="rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          Checkout was canceled — nothing was charged. Pick a plan whenever you&apos;re ready.
        </p>
      ) : null}

      {!live ? (
        <p className="rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          Demo mode — checkout is not available without a database and Stripe configured.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        {SELF_CHECKOUT_PLAN_IDS.map((planId) => {
          const plan = PLANS[planId];
          const featured = planId === "operations";
          return (
            <article
              key={planId}
              className={cn(
                "flex flex-col rounded-md border bg-card p-5",
                featured ? "border-2 border-primary" : "border-border",
              )}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-foreground">{plan.label}</h2>
                {featured ? (
                  <span className="rounded-sm border border-primary/30 bg-primary/[0.07] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                    Most popular
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-2xl font-bold tabular-nums text-foreground">
                {plan.priceMonthly != null ? usd(plan.priceMonthly) : "Custom"}
                <span className="text-sm font-medium text-muted-foreground"> / mo</span>
              </p>
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                <li>Up to {plan.maxActiveVendors} active vendors</li>
                <li>
                  {plan.maxInternalUsers
                    ? `${plan.maxInternalUsers} internal users`
                    : "Unlimited users"}
                </li>
                <li className="capitalize">{plan.managedService} managed service</li>
              </ul>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  checkout.mutate(planId);
                }}
                disabled={!live || checkout.isPending}
                className={cn(
                  "focusable mt-5 rounded-sm px-3 py-2 text-sm font-semibold disabled:opacity-60",
                  featured
                    ? "bg-primary text-primary-foreground"
                    : "border border-input bg-card text-foreground",
                )}
              >
                {checkout.isPending && checkout.variables === planId
                  ? "Starting…"
                  : preselected === planId
                    ? `Continue with ${plan.label}`
                    : `Choose ${plan.label}`}
              </button>
            </article>
          );
        })}
      </div>

      <div className="rounded-md border border-border bg-card p-5">
        <h2 className="text-sm font-bold text-foreground">Enterprise</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          300+ vendors, multiple business units, custom workflows or integrations. Talk to us for a
          quote — no self-checkout.
        </p>
        <a
          href="https://vendorclr.com/pricing"
          className="focusable mt-3 inline-flex rounded-sm border border-input bg-card px-3 py-2 text-sm font-semibold text-foreground"
        >
          Talk to Sales
        </a>
      </div>

      <p className="text-xs text-muted-foreground">
        Have an activation code instead?{" "}
        <Link to={routes.demo} className="font-medium text-primary underline">
          Enter it here
        </Link>
        .
      </p>
    </>,
  );
}
