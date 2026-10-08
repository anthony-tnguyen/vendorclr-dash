import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpFromLine, ChevronRight, X } from "lucide-react";

import { useSession } from "@/app/App";
import { useSignOut } from "@/app/useSignOut";
import { customerNav, routes } from "@/app/router";
import { StatusIcon, statusIconStyles } from "@/components/compliance/statusVisuals";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import { LegalConsent, LegalLinks } from "@/features/legal/LegalPages";
import { createDemoRepository } from "@/data/demoRepository";
import {
  STATUS_LABELS,
  type ComplianceItem,
  type ComplianceKey,
  type ComplianceStatus,
  type Vendor,
} from "@/data/contracts";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { cn } from "@/lib/utils";

/**
 * The screen an account sees before a paid activation code has been entered.
 *
 * It is dressed to look like the real compliance console - the same sidebar,
 * header, attention queue and vendor-compliance matrix a paying customer sees -
 * so a new account can get a true feel for the product before paying. What it is
 * NOT is functional.
 *
 * Read-only by construction: everything on screen is rendered from a fresh
 * in-memory demo repository (`createDemoRepository()`), never from
 * `getRepository()`, so the sample vendor records here are structurally
 * incapable of being the caller's real data and there is nothing to write to.
 * That is also why this screen works with no database configured at all, which
 * is what lets it be tested. Navigation items, toolbar actions and the detail
 * inspector are inert or purely local - none of them reach a backend, mutate
 * anything or leave this screen.
 *
 * The one control that does anything real is the activation code form, and only
 * when a backend is configured. In the preview it says so rather than faking a
 * successful activation.
 */

// Sample identity shown in the chrome so the preview reads like a real, lived-in
// workspace rather than an empty "No company yet" shell. It is cosmetic only.
const SAMPLE_PERSON = "Rosa Sandoval";
const SAMPLE_COMPANY = "Halstead Builders";

const requirementLabels: Record<ComplianceKey, string> = {
  coi: "Certificate of insurance",
  additionalInsured: "Additional insured",
  waiverOfSubrogation: "Waiver of subrogation",
  lienWaiver: "Lien waiver",
  renewal: "Renewal",
};

const complianceOrder: ComplianceKey[] = [
  "coi",
  "additionalInsured",
  "waiverOfSubrogation",
  "lienWaiver",
  "renewal",
];

// Columns rendered with tighter horizontal padding in the matrix, mirroring the
// real overview page.
const tightSpacingColumns = new Set<ComplianceKey>(["coi", "waiverOfSubrogation"]);

const statusRank: Record<ComplianceStatus, number> = {
  expired: 5,
  missing: 4,
  pending: 3,
  expiring: 2,
  compliant: 0,
};

type AttentionFilter = "action" | "expiring" | "pending";

const filterConfig: Array<{
  id: AttentionFilter;
  label: string;
  statuses: ComplianceStatus[];
  dotClass: string;
}> = [
  {
    id: "action",
    label: "Action needed",
    statuses: ["missing", "expired"],
    dotClass: "bg-destructive",
  },
  { id: "expiring", label: "Expiring soon", statuses: ["expiring"], dotClass: "bg-warn" },
  { id: "pending", label: "Pending review", statuses: ["pending"], dotClass: "bg-primary" },
];

function primaryException(vendor: Vendor) {
  return [...vendor.compliance]
    .filter((item) => item.status !== "compliant")
    .sort((a, b) => statusRank[b.status] - statusRank[a.status])[0];
}

function filterException(vendor: Vendor, filter: AttentionFilter) {
  const statuses = filterConfig.find((item) => item.id === filter)?.statuses ?? [];
  return [...vendor.compliance]
    .filter((item) => statuses.includes(item.status))
    .sort((a, b) => statusRank[b.status] - statusRank[a.status])[0];
}

function formatDate(value: string | null) {
  if (!value) return "No date on file";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateNumeric(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function statusTextClass(status: ComplianceStatus) {
  if (status === "compliant") return "text-ok";
  if (status === "expiring") return "text-warn";
  if (status === "pending") return "text-primary";
  return "text-destructive";
}

function ComplianceStatusCell({ item }: { item: ComplianceItem }) {
  const description = `${requirementLabels[item.key]}: ${STATUS_LABELS[item.status]}, ${formatDate(item.effectiveDate)}`;
  return (
    <div role="status" aria-label={description} title={description}>
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-semibold",
          statusTextClass(item.status),
        )}
      >
        <StatusIcon status={item.status} className={statusIconStyles[item.status]} />
        {STATUS_LABELS[item.status]}
      </p>
      <p className="numeric mt-1 text-left text-[11px] text-muted-foreground">
        {formatDateNumeric(item.effectiveDate)}
      </p>
    </div>
  );
}

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

/** Read-only detail popup, the same shape as the real console's resolution
 * inspector, but with nothing to act on - it only describes the sample record. */
function DemoInspector({
  vendor,
  exception,
  onClose,
}: {
  vendor: Vendor;
  exception: ComplianceItem;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Resolution inspector"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-md border border-border bg-card p-5 shadow-[0_24px_48px_-24px_rgb(15_23_42/0.65)]"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Resolution inspector
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close resolution inspector"
            className="focusable -mr-1 -mt-1 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="mt-4 border-y border-border py-4">
          <p className="font-semibold text-foreground">{vendor.name}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {vendor.trade} · {vendor.project}
          </p>
        </div>
        <dl className="mt-4 space-y-4 text-sm">
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">Requirement</dt>
            <dd className="mt-1 font-medium text-foreground">{requirementLabels[exception.key]}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">Current status</dt>
            <dd className={cn("mt-1 font-semibold", statusTextClass(exception.status))}>
              {STATUS_LABELS[exception.status]}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-muted-foreground">Evidence</dt>
            <dd className="mt-1 text-foreground">
              {exception.note ?? formatDate(exception.effectiveDate)}
            </dd>
          </div>
        </dl>
        <p className="mt-5 rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          In an activated workspace you&apos;d open the vendor record here to review evidence and
          send a document request. This is sample data, so there is nothing to action.
        </p>
      </div>
    </div>
  );
}

function OverviewPreview() {
  const repository = useMemo(() => createDemoRepository(), []);
  const vendors = useQuery({
    queryKey: ["demo-sample-vendors"],
    queryFn: () => repository.listVendors(),
  });
  const [filter, setFilter] = useState<AttentionFilter>("action");
  const [inspectedVendorId, setInspectedVendorId] = useState<string>();

  const allVendors = useMemo(() => vendors.data ?? [], [vendors.data]);
  const attention = useMemo(
    () =>
      allVendors
        .filter((vendor) => filterException(vendor, filter))
        .sort(
          (a, b) =>
            statusRank[filterException(b, filter)?.status ?? "compliant"] -
            statusRank[filterException(a, filter)?.status ?? "compliant"],
        ),
    [allVendors, filter],
  );
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        filterConfig.map(({ id, statuses }) => [
          id,
          allVendors.filter((vendor) =>
            vendor.compliance.some((item) => statuses.includes(item.status)),
          ).length,
        ]),
      ) as Record<AttentionFilter, number>,
    [allVendors],
  );

  const inspectedVendor = attention.find((vendor) => vendor.id === inspectedVendorId);
  const inspectedException = inspectedVendor && filterException(inspectedVendor, filter);

  const selectFilter = (next: AttentionFilter) => {
    setFilter(next);
    setInspectedVendorId(undefined);
  };

  if (vendors.isPending) {
    return <LoadingState label="Loading sample vendor roster" rows={6} />;
  }

  if (vendors.isError) {
    return (
      <ErrorState description="The sample data could not be loaded. Nothing was changed — this is read-only sample content." />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2" aria-label="Compliance filters">
        {filterConfig.map((item) => {
          const active = filter === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={active}
              aria-label={`Show ${item.label.toLowerCase()}`}
              onClick={() => selectFilter(item.id)}
              className={cn(
                "focusable inline-flex items-center gap-2 rounded-sm border px-3 py-2 text-xs font-semibold transition-colors",
                active
                  ? "border-primary/35 bg-primary/5 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              <span aria-hidden="true" className={cn("size-2 rounded-full", item.dotClass)} />
              {item.label}
              <span className="numeric text-[10px] text-muted-foreground">
                {filterCounts[item.id]}
              </span>
            </button>
          );
        })}
      </div>

      <section
        aria-labelledby="attention-heading"
        className="min-w-0 rounded-md border border-border bg-card p-4 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.45)] sm:p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="attention-heading"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              Needs attention
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {filterConfig.find((item) => item.id === filter)?.label} items, ordered by urgency.
            </p>
          </div>
          <span className="numeric rounded-sm border border-border px-2 py-1 text-[11px] text-muted-foreground">
            {attention.length} shown
          </span>
        </div>

        {attention.length === 0 ? (
          <p className="mt-4 rounded-sm border border-dashed border-border bg-background p-4 text-center text-sm text-muted-foreground">
            No {filterConfig.find((item) => item.id === filter)?.label.toLowerCase()} items in the
            sample data. Choose another status to review the rest of the queue.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-sm border border-border">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead className="bg-muted/55 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Vendor</th>
                  <th className="px-3 py-2.5 font-semibold">Issue</th>
                  <th className="px-3 py-2.5 font-semibold">Project</th>
                  <th className="px-3 py-2.5 font-semibold">Next step</th>
                </tr>
              </thead>
              <tbody>
                {attention.map((vendor) => {
                  const exception = filterException(vendor, filter)!;
                  return (
                    <tr key={vendor.id} className="border-t border-border">
                      <td className="px-3 py-3 align-top">
                        <p className="font-semibold text-foreground">{vendor.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{vendor.trade}</p>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <p className="flex items-center gap-2 font-medium text-foreground">
                          <StatusIcon
                            status={exception.status}
                            className={statusIconStyles[exception.status]}
                          />
                          {requirementLabels[exception.key]}
                        </p>
                        <p
                          className={cn(
                            "mt-1 pl-5 text-xs font-semibold",
                            statusTextClass(exception.status),
                          )}
                        >
                          {STATUS_LABELS[exception.status]}
                        </p>
                      </td>
                      <td className="px-3 py-3 align-top text-muted-foreground">
                        {vendor.project}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <button
                          type="button"
                          aria-label={`Inspect ${vendor.name}`}
                          onClick={() => setInspectedVendorId(vendor.id)}
                          className="focusable inline-flex items-center gap-1 text-xs font-semibold text-primary underline underline-offset-4"
                        >
                          Inspect details
                          <ChevronRight aria-hidden="true" className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SampleRoster vendors={allVendors} />

      {inspectedVendor && inspectedException ? (
        <DemoInspector
          vendor={inspectedVendor}
          exception={inspectedException}
          onClose={() => setInspectedVendorId(undefined)}
        />
      ) : null}
    </div>
  );
}

function SampleRoster({ vendors }: { vendors: Vendor[] }) {
  return (
    <section
      aria-labelledby="sample-roster-heading"
      className="min-w-0 rounded-md border border-border bg-card p-4 shadow-[0_12px_28px_-24px_rgb(15_23_42/0.45)] sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2
            id="sample-roster-heading"
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            Sample vendor roster
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Current requirement status across every vendor in the sample workspace.
          </p>
        </div>
        <p className="numeric text-xs text-muted-foreground">
          {vendors.length} vendors · read-only
        </p>
      </div>

      {/* Dense matrix - the same read the real register uses. Scrolls
          horizontally on narrow screens, exactly like the live console. */}
      <div className="mt-4 overflow-x-auto rounded-sm border border-border">
        <table
          aria-label="Vendor compliance"
          className="w-full min-w-[46rem] border-collapse text-left"
        >
          <thead className="bg-muted/55 text-xs text-muted-foreground">
            <tr>
              <th className="px-2.5 py-2 align-bottom font-semibold">Vendor</th>
              {complianceOrder.map((key) => (
                <th
                  key={key}
                  className={`border-l border-border/60 ${
                    tightSpacingColumns.has(key) ? "px-1" : "px-2"
                  } py-2 align-bottom font-semibold`}
                >
                  {requirementLabels[key]}
                </th>
              ))}
              <th className="border-l border-border/60 px-2.5 py-2 align-bottom font-semibold">
                Project
              </th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((vendor) => (
              <tr
                key={vendor.id}
                data-testid="demo-vendor-row"
                className="border-t border-border hover:bg-muted/35"
              >
                <td className="px-2.5 py-3 align-top">
                  <p className="text-sm font-semibold text-foreground">{vendor.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{vendor.trade}</p>
                </td>
                {complianceOrder.map((key) => {
                  const item = vendor.compliance.find((entry) => entry.key === key) ?? {
                    key,
                    status: "missing" as const,
                    effectiveDate: null,
                  };
                  return (
                    <td
                      key={key}
                      className={`border-l border-border/60 ${
                        tightSpacingColumns.has(key) ? "px-1" : "px-2"
                      } py-3 align-top`}
                    >
                      <ComplianceStatusCell item={item} />
                    </td>
                  );
                })}
                <td className="border-l border-border/60 px-2.5 py-3 align-top text-xs text-muted-foreground">
                  {vendor.project}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

/** The inert sidebar - the real console's nav, styled identically, but every
 * item is a label rather than a link. Nothing here navigates. */
function DemoSidebar() {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-4">
        <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
        <span className="numeric rounded-sm border border-sidebar-border px-1.5 py-0.5 text-[10px] uppercase text-sidebar-foreground/70">
          CUSTOMER
        </span>
      </div>
      <nav aria-label="Dashboard sections (preview)" className="space-y-4 px-1 pb-4">
        <div>
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/60">
            Workspace
          </p>
          <ul className="mt-2 space-y-0.5">
            {customerNav.map((item, index) => (
              <li key={item.to}>
                <span
                  aria-disabled="true"
                  title="Available once your workspace is activated"
                  className={cn(
                    "block cursor-default rounded-sm px-3 py-2 text-sm",
                    index === 0
                      ? "bg-sidebar-accent font-semibold text-sidebar-foreground"
                      : "text-sidebar-foreground/70",
                  )}
                >
                  {item.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </nav>
      <div className="px-3 pb-6">
        <div className="rounded-sm border border-warn/40 bg-warn-soft p-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-warn">Demo mode</p>
          <p className="mt-1 text-xs text-foreground">
            A read-only preview built from sample data. Nothing here is saved or sent.
          </p>
        </div>
        <LegalLinks className="mt-4 flex gap-3 px-1 text-[11px] text-sidebar-foreground/70" />
      </div>
    </>
  );
}

export function DemoScreen() {
  const { status, activation, isStaff, personName } = useSession();
  const { signOut, error: signOutError } = useSignOut();
  const revoked = activation === "revoked";
  const noCompanyYet = activation === "none" || activation === "demo";
  const displayName = personName || SAMPLE_PERSON;

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-background px-4 py-6">
        <div className="mx-auto w-full max-w-3xl">
          <LoadingState label="Checking your account" rows={5} />
        </div>
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border bg-card">
          <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
            <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
            <span className="numeric rounded-sm border border-warn/40 bg-warn-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warn">
              Demo console
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
          <SignedOutPrompt />
        </main>
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
          <DemoSidebar />
        </aside>

        <div className="min-w-0 flex-1">
          {/* Mobile brand bar - the desktop sidebar is hidden below lg. */}
          <div className="flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 py-3 text-sidebar-foreground lg:hidden">
            <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
            <span className="numeric rounded-sm border border-sidebar-border px-1.5 py-0.5 text-[10px] uppercase text-sidebar-foreground/70">
              CUSTOMER
            </span>
          </div>

          <header className="border-b border-border bg-card px-4 py-4 sm:px-6">
            <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="text-lg font-bold tracking-tight text-foreground">
                  Compliance overview
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  A live-feeling preview of your compliance console, built from VendorClr sample
                  data.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled
                  aria-label="Import vendors (available after activation)"
                  title="Available once your workspace is activated"
                  className="inline-flex cursor-not-allowed items-center gap-2 rounded-sm border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground opacity-70"
                >
                  <ArrowUpFromLine aria-hidden="true" className="size-4" />
                  Import vendors
                </button>
                <span
                  className={cn(
                    "numeric rounded-sm border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider",
                    revoked
                      ? "border-destructive/40 bg-danger-soft text-destructive"
                      : "border-warn/40 bg-warn-soft text-warn",
                  )}
                >
                  {revoked ? "Access ended" : "Demo console"}
                </span>
                <button
                  type="button"
                  onClick={signOut}
                  className="focusable rounded-sm border border-input px-3 py-1.5 text-xs font-semibold text-foreground"
                >
                  Sign out
                </button>
                <div className="rounded-sm border border-border px-2 py-1 text-right">
                  <p className="text-xs font-semibold text-foreground">{displayName}</p>
                  <p className="text-[11px] text-muted-foreground">{SAMPLE_COMPANY}</p>
                </div>
              </div>
            </div>
            {signOutError ? (
              <div className="mx-auto mt-3 w-full max-w-[100rem]">
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
            className="mx-auto w-full max-w-[100rem] space-y-6 px-4 py-6 sm:px-6"
          >
            {revoked ? (
              <section
                aria-labelledby="access-ended-heading"
                className="rounded-md border border-destructive/30 bg-danger-soft p-4"
              >
                <h2 id="access-ended-heading" className="text-sm font-bold text-destructive">
                  Your VendorClr access has ended
                </h2>
                <p className="mt-1 text-sm text-foreground">
                  A VendorClr administrator closed this workspace. Your vendors, documents and
                  history are still stored — nothing has been deleted — but the console is closed
                  until access is restored. The figures below are sample data, not your account.
                </p>
                <p className="mt-2 text-sm text-foreground">
                  To restore it, contact your VendorClr contact, or enter a new activation code
                  below.
                </p>
              </section>
            ) : (
              <section
                aria-labelledby="demo-intro-heading"
                className="rounded-md border border-warn/40 bg-warn-soft p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 id="demo-intro-heading" className="text-sm font-bold text-warn">
                      This is the demo console
                    </h2>
                    <p className="mt-1 text-sm text-foreground">
                      Everything below is VendorClr&apos;s built-in sample construction data, not
                      your account. It is read-only: there is nothing here to add, upload, request
                      or delete, and nothing you do on this screen is saved or sent to anyone.
                    </p>
                    <p className="mt-2 text-sm text-foreground">
                      {noCompanyYet
                        ? "Your account has no workspace yet. Subscribe to a plan to open your own console with your real vendors, or enter the activation code your VendorClr contact gave you."
                        : "Enter a new activation code to open another workspace."}
                    </p>
                  </div>
                  {noCompanyYet ? (
                    <Link
                      to={routes.checkout}
                      className="focusable inline-flex shrink-0 rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                    >
                      Subscribe to a plan →
                    </Link>
                  ) : null}
                </div>
              </section>
            )}

            <OverviewPreview />

            <ActivationForm />

            <p className="text-xs text-muted-foreground">
              {isStaff
                ? "You are signed in as VendorClr staff, so the real console stays available to you alongside this demo."
                : "Questions about activation? Ask the VendorClr contact who set your account up."}
            </p>
          </main>

          <footer className="border-t border-border px-4 py-4 text-xs text-muted-foreground sm:px-6">
            <div className="mx-auto w-full max-w-[100rem]">
              Demo environment. The vendors, dates and statuses above are sample data; uploads,
              emails, reviews and exports are not available until your workspace is activated.
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
