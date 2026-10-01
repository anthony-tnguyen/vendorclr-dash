import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { useSession } from "@/app/App";
import { useSignOut } from "@/app/useSignOut";
import { routes } from "@/app/router";
import { ComplianceMatrix } from "@/components/compliance/ComplianceMatrix";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import { LegalConsent } from "@/features/legal/LegalPages";
import { createDemoRepository } from "@/data/demoRepository";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { cn } from "@/lib/utils";

/**
 * The screen an account sees before a paid activation code has been entered.
 *
 * Read-only by construction: the roster is rendered from a fresh in-memory demo
 * repository (`createDemoRepository()`), never from `getRepository()`, so the
 * sample vendor records here are structurally incapable of being the caller's
 * real data and there is nothing to write to. That is also why this screen works
 * with no database configured at all, which is what lets it be tested.
 *
 * The one control that does anything real is the activation code form, and only
 * when a backend is configured. In the preview it says so rather than faking a
 * successful activation.
 */

const UNLOCKED_POINTS = [
  {
    title: "Your own vendor roster",
    detail:
      "Add your subcontractors once and track COI, additional insured, waiver of subrogation, lien waiver and renewal status for each.",
  },
  {
    title: "Document requests that reach people",
    detail:
      "Ask a vendor, their broker or a second contact for what's missing, and see whether it was delivered, bounced or uploaded.",
  },
  {
    title: "Requirements you control",
    detail:
      "Set your own minimum limits and required endorsements per project, and keep the history of who changed what.",
  },
  {
    title: "Reporting you can hand over",
    detail: "Project-level compliance reporting and CSV export, generated from your live data.",
  },
];

interface FormState {
  status: "idle" | "pending" | "done" | "error";
  message: string | null;
}

function ActivationForm() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const live = isBackendConfigured();
  const [state, setState] = useState<FormState>({ status: "idle", message: null });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get("activation-code") ?? "").trim();

    if (!live) {
      setState({
        status: "error",
        message:
          "This preview has no database connected, so codes cannot be checked or redeemed here.",
      });
      return;
    }

    if (!code) {
      setState({
        status: "error",
        message: "Enter the activation code your VendorClr contact gave you.",
      });
      return;
    }

    setState({ status: "pending", message: null });
    try {
      const workspace = await getRepository().redeemActivationCode(code);
      refresh();
      await navigate({ to: routes.dashboard });
      setState({
        status: "done",
        message: `${workspace.companyName} is activated. Your workspace is empty until you add vendors.`,
      });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error && error.message ? error.message : "That code was not recognised.",
      });
    }
  }

  return (
    <section
      aria-labelledby="activation-heading"
      className="rounded-md border border-border bg-card p-5"
    >
      <h2 id="activation-heading" className="text-sm font-bold tracking-tight text-foreground">
        Have an activation code?
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Entering it creates your company&apos;s workspace and opens the real console for you and
        anyone you add later. Codes come from your VendorClr contact once your account is paid for.
      </p>

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="activation-code" className="block text-sm font-medium text-foreground">
            Activation code
          </label>
          <input
            id="activation-code"
            name="activation-code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="activation-code-hint"
            className="focusable numeric w-full rounded-sm border border-input bg-card px-3 py-2 text-sm uppercase text-foreground"
          />
          <p id="activation-code-hint" className="text-xs text-muted-foreground">
            Ten characters. It only works from the email address it was issued to.
          </p>
        </div>

        <button
          type="submit"
          disabled={state.status === "pending"}
          className="focusable w-full rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {state.status === "pending" ? "Checking…" : "Activate my workspace"}
        </button>
        <LegalConsent action="activating your workspace" />
      </form>

      {state.status === "error" && state.message ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
        >
          {state.message}
        </p>
      ) : null}

      {state.status === "done" && state.message ? (
        <p
          role="status"
          className="mt-3 rounded-sm border border-ok/40 bg-ok-soft px-3 py-2 text-xs font-semibold text-ok"
        >
          {state.message}
        </p>
      ) : null}

      {live ? null : (
        <p className="mt-3 rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          Demo mode — this preview is not connected to a database, so nothing here can be activated,
          saved or sent.
        </p>
      )}
    </section>
  );
}

function SampleRoster() {
  const repository = useMemo(() => createDemoRepository(), []);
  const vendors = useQuery({
    queryKey: ["demo-sample-vendors"],
    queryFn: () => repository.listVendors(),
  });

  if (vendors.isPending) {
    return <LoadingState label="Loading sample vendor roster" rows={5} />;
  }

  if (vendors.isError) {
    return (
      <ErrorState description="The sample data could not be loaded. Nothing was changed — this is read-only sample content." />
    );
  }

  const roster = vendors.data;

  if (roster.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-6 text-center">
        <h3 className="text-sm font-semibold text-foreground">Sample roster is empty</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The built-in sample vendor list came back with no rows.
        </p>
      </div>
    );
  }

  return (
    <section aria-labelledby="sample-roster-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sample-roster-heading" className="text-sm font-bold tracking-tight text-foreground">
          Sample vendor roster
        </h2>
        <p className="numeric text-xs text-muted-foreground">{roster.length} vendors · read-only</p>
      </div>

      <ul className="space-y-2">
        {roster.map((vendor) => (
          <li
            key={vendor.id}
            className="rounded-md border border-border bg-card p-4"
            data-testid="demo-vendor-row"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{vendor.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {vendor.trade} · {vendor.project}
                </p>
              </div>
              <dl className="shrink-0 text-right">
                <div>
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Policy
                  </dt>
                  <dd className="numeric text-xs text-foreground">{vendor.policyNumber}</dd>
                </div>
                <div className="mt-1">
                  <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Expires
                  </dt>
                  <dd className="numeric text-xs text-foreground">{vendor.expiresOn}</dd>
                </div>
              </dl>
            </div>
            <div className="mt-3">
              <ComplianceMatrix items={vendor.compliance} vendorName={vendor.name} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SignedOutPrompt() {
  return (
    <div className="rounded-md border border-border bg-card p-5">
      <h2 className="text-sm font-bold tracking-tight text-foreground">
        You&apos;re not signed in
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The demo console sits behind a free account. Create one with your work email — no code
        needed — or sign in if you already have one.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
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
    </div>
  );
}

export function DemoScreen() {
  const { status, activation, isStaff, personName } = useSession();
  const { signOut, error: signOutError } = useSignOut();
  const revoked = activation === "revoked";
  const noCompanyYet = activation === "none" || activation === "demo";

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        onClick={() => document.getElementById("main-content")?.focus()}
        className="focusable sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-card focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to main content
      </a>

      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
            <span
              className={cn(
                "numeric rounded-sm border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                revoked
                  ? "border-destructive/40 bg-danger-soft text-destructive"
                  : "border-warn/40 bg-warn-soft text-warn",
              )}
            >
              {revoked ? "Access ended" : "Demo console"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {personName ? (
              <span className="truncate text-xs text-muted-foreground">{personName}</span>
            ) : null}
            <button
              type="button"
              onClick={signOut}
              className="focusable rounded-sm border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>
        {signOutError ? (
          <div className="mx-auto w-full max-w-4xl px-4 pb-3 sm:px-6">
            <p
              role="alert"
              className="rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
            >
              {signOutError}
            </p>
          </div>
        ) : null}
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 sm:px-6"
      >
        {status === "loading" ? (
          <LoadingState label="Checking your account" rows={3} />
        ) : status === "anonymous" ? (
          <SignedOutPrompt />
        ) : (
          <>
            {revoked ? (
              <section
                aria-labelledby="access-ended-heading"
                className="rounded-md border border-destructive/30 bg-danger-soft p-5"
              >
                <h2 id="access-ended-heading" className="text-sm font-bold text-destructive">
                  Your VendorClr access has ended
                </h2>
                <p className="mt-1 text-sm text-foreground">
                  A VendorClr administrator closed this workspace. Your vendors, documents and
                  history are still stored — nothing has been deleted — but the console is closed
                  until access is restored.
                </p>
                <p className="mt-2 text-sm text-foreground">
                  To restore it, contact your VendorClr contact, or enter a new activation code
                  below.
                </p>
              </section>
            ) : (
              <section
                aria-labelledby="demo-intro-heading"
                className="rounded-md border border-warn/40 bg-warn-soft p-5"
              >
                <h2 id="demo-intro-heading" className="text-sm font-bold text-warn">
                  This is the demo console
                </h2>
                <p className="mt-1 text-sm text-foreground">
                  Everything below is VendorClr&apos;s built-in sample construction data, not your
                  account. It is read-only: there is nothing here to add, upload, request or delete,
                  and nothing you do on this screen is saved or sent to anyone.
                </p>
                <p className="mt-2 text-sm text-foreground">
                  {noCompanyYet
                    ? "Your account has no workspace yet. Subscribe to a plan to open one now, or enter the activation code your VendorClr contact gave you."
                    : "Enter a new activation code to open another workspace."}
                </p>
                {noCompanyYet ? (
                  <p className="mt-3">
                    <Link
                      to={routes.checkout}
                      className="focusable inline-flex rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                    >
                      Subscribe to a plan →
                    </Link>
                  </p>
                ) : null}
              </section>
            )}

            <SampleRoster />

            <section
              aria-labelledby="unlocked-heading"
              className="rounded-md border border-border bg-card p-5"
            >
              <h2
                id="unlocked-heading"
                className="text-sm font-bold tracking-tight text-foreground"
              >
                What an activated workspace does
              </h2>
              <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                {UNLOCKED_POINTS.map((point) => (
                  <li
                    key={point.title}
                    className="rounded-sm border border-border bg-background p-3"
                  >
                    <p className="text-sm font-semibold text-foreground">{point.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{point.detail}</p>
                  </li>
                ))}
              </ul>
            </section>

            <ActivationForm />

            <p className="text-xs text-muted-foreground">
              {isStaff
                ? "You are signed in as VendorClr staff, so the real console stays available to you alongside this demo."
                : "Questions about activation? Ask the VendorClr contact who set your account up."}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
