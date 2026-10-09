import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";

import { useSession } from "@/app/App";
import { routes } from "@/app/router";
import { useSignOut } from "@/app/useSignOut";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { OnboardingPatch, OnboardingState } from "@/data/contracts";
import { getRepository, isBackendConfigured } from "@/data/repository";
import { CONTACT_EMAIL } from "@/features/legal/LegalPages";
import { OnboardingReviewSummary } from "@/features/onboarding/OnboardingReviewSummary";
import {
  missingRequired,
  normalizeCompanyInfo,
  sectionForStep,
  stepIsEmpty,
  type Section,
  type WizardSections,
} from "@/features/onboarding/onboardingSections";
import { cn } from "@/lib/utils";

/**
 * Post-checkout onboarding wizard.
 *
 * Steps 1-3 and 5 are captured into company_onboarding as free-form answers the
 * VendorClr team reviews; step 4 (vendors) sends the customer to the real CSV /
 * COI importers. Step 6 submits, which moves the company from onboarding to
 * in_review (submit_company_onboarding); after that the page shows a waiting
 * state until staff mark the workspace live and the console opens.
 *
 * The gate itself lives in AppShell (service_status); this page is standalone.
 */

const STEP_LABELS = [
  "Company",
  "Compliance program",
  "Projects",
  "Vendors",
  "Requirements",
  "Review",
] as const;

const COVERAGE_OPTIONS = [
  "General Liability",
  "Workers' Compensation",
  "Auto Liability",
  "Umbrella / Excess",
  "Additional Insured",
  "Waiver of Subrogation",
  "Primary & Noncontributory",
];

function text(section: Section, key: string): string {
  const value = section[key];
  return typeof value === "string" ? value : "";
}

function stringArray(section: Section, key: string): string[] {
  const value = section[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const inputClass =
  "focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground";
const labelClass = "block text-sm font-medium text-foreground";

function Header({
  personName,
  onSignOut,
  signOutError,
}: {
  personName: string;
  onSignOut: () => void;
  signOutError: string | null;
}) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
          <span className="numeric rounded-sm border border-primary/30 bg-primary/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            Onboarding
          </span>
        </div>
        <div className="flex items-center gap-3">
          {personName ? (
            <span className="truncate text-xs text-muted-foreground">{personName}</span>
          ) : null}
          <button
            type="button"
            onClick={onSignOut}
            className="focusable rounded-sm border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
      {signOutError ? (
        <div className="mx-auto w-full max-w-3xl px-4 pb-3 sm:px-6">
          <p
            role="alert"
            className="rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
          >
            {signOutError}
          </p>
        </div>
      ) : null}
    </header>
  );
}

function ProvisioningState() {
  return (
    <section
      role="status"
      aria-live="polite"
      className="rounded-md border border-primary/25 bg-card p-6 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Payment confirmed</p>
      <h1 className="mt-2 text-xl font-bold tracking-tight text-foreground">
        We&apos;re preparing your VendorClr workspace
      </h1>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        Your purchase is complete. We&apos;re connecting your company and setup details now. This
        normally takes only a few seconds.
      </p>
      <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full w-2/3 animate-pulse rounded-full bg-primary" />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Keep this page open — we&apos;ll continue automatically.
      </p>
    </section>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap gap-2" aria-label="Onboarding progress">
      {STEP_LABELS.map((label, index) => {
        const n = index + 1;
        const state = n === step ? "current" : n < step ? "done" : "upcoming";
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "numeric rounded-sm border px-2.5 py-1 text-[11px] font-medium",
              state === "current"
                ? "border-primary bg-primary text-primary-foreground"
                : state === "done"
                  ? "border-ok/40 bg-ok-soft text-ok"
                  : "border-border bg-card text-muted-foreground",
            )}
          >
            {n}. {label}
          </li>
        );
      })}
    </ol>
  );
}

function UnderReviewScreen({
  companyName,
  sections,
  onEditStep,
}: {
  companyName: string;
  sections: WizardSections;
  onEditStep: (step: number) => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-md border border-border bg-card p-6">
        <h2 className="text-base font-bold tracking-tight text-foreground">
          Your setup is under review
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We&apos;ve received {companyName || "your"} onboarding details and a VendorClr specialist
          is validating your vendors, requirement profiles and project setup. Managed service — the
          automated requests and renewal outreach we run for you — turns on once that&apos;s done.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          In the meantime your workspace is open: you can keep building it, and you can still edit
          anything below and resubmit until we launch.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            to={routes.dashboard}
            className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            Go to your dashboard
          </Link>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="focusable rounded-sm border border-input bg-card px-3 py-2 text-sm font-semibold text-foreground"
          >
            Contact VendorClr
          </a>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-bold tracking-tight text-foreground">Your setup</h3>
        <OnboardingReviewSummary sections={sections} onEditStep={onEditStep} />
      </section>
    </div>
  );
}

export function OnboardingPage() {
  // Never render the wizard - or fire its queries - while the session is
  // anonymous. RequireAuth redirects an anonymous visitor to sign-in.
  return (
    <RequireAuth loadingLabel="Loading your onboarding">
      <OnboardingWizard />
    </RequireAuth>
  );
}

function OnboardingWizard() {
  const { personName, companyName, serviceStatus, status, refresh } = useSession();
  const { signOut, error: signOutError } = useSignOut();
  const repo = useMemo(() => getRepository(), []);
  const queryClient = useQueryClient();
  const checkoutSuccess = useRouterState({
    select: (state) =>
      String((state.location.search as Record<string, unknown>)["checkout"] ?? "") === "success",
  });

  const onboarding = useQuery({
    queryKey: ["onboarding"],
    queryFn: async () => {
      const loaded = await repo.getOnboarding();
      if (checkoutSuccess && loaded === null) {
        throw new Error("Workspace provisioning is still in progress.");
      }
      return loaded;
    },
    // Stripe may redirect before its webhook has finished creating the company,
    // membership and onboarding row. Retry that expected race before showing an
    // error, while keeping ordinary visits responsive.
    retry: checkoutSuccess ? 10 : 2,
    retryDelay: checkoutSuccess ? 1_500 : 1_000,
    enabled: status === "authenticated",
  });

  const [step, setStep] = useState(1);
  const [companyInfo, setCompanyInfo] = useState<Section>({});
  const [program, setProgram] = useState<Section>({});
  const [projects, setProjects] = useState<Section>({});
  const [requirements, setRequirements] = useState<Section>({});
  const [seeded, setSeeded] = useState(false);
  // Once submitted, the page shows the under-review summary; "editing" drops back
  // into the wizard so the customer can correct answers and resubmit until launch.
  const [editing, setEditing] = useState(false);

  // Seed local form state once from whatever was saved, so a returning customer
  // resumes where they left off.
  useEffect(() => {
    if (seeded || onboarding.data === undefined) return;
    const loaded: OnboardingState | null = onboarding.data;
    if (loaded) {
      setCompanyInfo(normalizeCompanyInfo(loaded.companyInfo));
      setProgram(loaded.program ?? {});
      setProjects(loaded.projects ?? {});
      setRequirements(loaded.requirements ?? {});
      setStep(Math.min(Math.max(loaded.currentStep || 1, 1), STEP_LABELS.length));
    }
    setSeeded(true);
  }, [onboarding.data, seeded]);

  const save = useMutation({
    mutationFn: (patch: OnboardingPatch) => repo.saveOnboarding(patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
  });

  const submit = useMutation({
    mutationFn: () => repo.submitOnboarding(),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    },
  });

  const live = isBackendConfigured();

  // Submitted / under review: show the waiting state regardless of local step.
  const submitted = serviceStatus === "in_review" || Boolean(onboarding.data?.submittedAt);

  const currentSections = { companyInfo, program, projects, requirements };
  // Company name was already supplied at checkout, so it is the one required
  // field; everything else is explicitly optional.
  const requiredMissing = missingRequired(currentSections);

  async function goNext() {
    const patch = {
      ...sectionForStep(step, currentSections),
      currentStep: Math.min(step + 1, STEP_LABELS.length),
    };
    if (live) await save.mutateAsync(patch);
    else await repo.saveOnboarding(patch);
    setStep((s) => Math.min(s + 1, STEP_LABELS.length));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
  }

  async function onSubmit() {
    // Optional answers never block or add another confirmation step.
    // Persist the last edited section before submitting.
    const finalPatch = {
      ...sectionForStep(step, currentSections),
      currentStep: STEP_LABELS.length,
    };
    if (live) await save.mutateAsync(finalPatch);
    else await repo.saveOnboarding(finalPatch);
    await submit.mutateAsync();
    // A resubmit from the editing flow returns to the under-review summary.
    setEditing(false);
  }

  async function saveBeforeImport() {
    const patch = {
      ...sectionForStep(4, currentSections),
      currentStep: 4,
    };
    if (live) await save.mutateAsync(patch);
    else await repo.saveOnboarding(patch);
  }

  function toggleCoverage(option: string) {
    const current = stringArray(requirements, "coverages");
    const next = current.includes(option)
      ? current.filter((c) => c !== option)
      : [...current, option];
    setRequirements({ ...requirements, coverages: next });
  }

  return (
    <div className="min-h-screen bg-background">
      <Header personName={personName} onSignOut={signOut} signOutError={signOutError} />
      <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6">
        {checkoutSuccess && onboarding.isPending ? (
          <ProvisioningState />
        ) : onboarding.isPending ? (
          <LoadingState label="Loading your onboarding" rows={4} />
        ) : onboarding.isError ? (
          <ErrorState
            title={checkoutSuccess ? "Your payment is confirmed" : "Your setup could not be loaded"}
            description={
              checkoutSuccess
                ? "Your workspace is taking longer than expected to prepare. Retry now — your payment and saved information are safe."
                : "Your onboarding could not be loaded. Nothing was changed."
            }
            onRetry={() => void onboarding.refetch()}
          />
        ) : submitted && !editing ? (
          <UnderReviewScreen
            companyName={companyName}
            sections={currentSections}
            onEditStep={(target) => {
              setEditing(true);
              setStep(target);
            }}
          />
        ) : (
          <>
            <div className="space-y-3">
              {submitted ? (
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="focusable text-xs font-semibold text-primary underline"
                >
                  ← Back to review
                </button>
              ) : null}
              {checkoutSuccess ? (
                <div className="rounded-md border border-ok/35 bg-ok-soft px-4 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-ok">
                    Payment confirmed
                  </p>
                  <p className="mt-1 text-sm text-foreground">
                    Welcome to VendorClr. Share the basics and VendorClr will take it from here.
                  </p>
                </div>
              ) : null}
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                Welcome to {companyName || text(companyInfo, "companyName") || "your VendorClr workspace"}
              </h1>
              <p className="text-sm text-muted-foreground">
                Confirm the essentials so our compliance team can start working for you. It takes
                about three minutes, and only your company name is required.
              </p>
              <Stepper step={step} />
            </div>

            <section className="rounded-md border border-border bg-card p-5">
              {step === 1 ? (
                <div className="space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Company</h2>
                  <p className="text-xs text-muted-foreground">
                    Only your company name is required. Everything else is optional — you can add it
                    now or from Settings later.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelClass} htmlFor="ob-company">
                        Company name <span className="text-destructive">*</span>
                      </label>
                      <input
                        id="ob-company"
                        className={inputClass}
                        required
                        aria-required="true"
                        value={text(companyInfo, "companyName")}
                        onChange={(e) =>
                          setCompanyInfo({ ...companyInfo, companyName: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="ob-contact">
                        Primary contact
                      </label>
                      <input
                        id="ob-contact"
                        className={inputClass}
                        value={text(companyInfo, "primaryContact")}
                        onChange={(e) =>
                          setCompanyInfo({ ...companyInfo, primaryContact: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="ob-industry">
                        Industry
                      </label>
                      <input
                        id="ob-industry"
                        className={inputClass}
                        value={text(companyInfo, "industry")}
                        onChange={(e) =>
                          setCompanyInfo({ ...companyInfo, industry: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="ob-location">
                        Location
                      </label>
                      <input
                        id="ob-location"
                        className={inputClass}
                        value={text(companyInfo, "location")}
                        onChange={(e) =>
                          setCompanyInfo({ ...companyInfo, location: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="ob-vendorcount">
                        Approximate active vendors
                      </label>
                      <input
                        id="ob-vendorcount"
                        className={inputClass}
                        inputMode="numeric"
                        value={text(companyInfo, "approxVendors")}
                        onChange={(e) =>
                          setCompanyInfo({ ...companyInfo, approxVendors: e.target.value })
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {step === 2 ? (
                <div className="space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Compliance program</h2>
                  <p className="text-xs text-muted-foreground">
                    Optional — skip anything now and add it from Settings later.
                  </p>
                  <div>
                    <label className={labelClass} htmlFor="ob-vendortypes">
                      Types of vendors / subcontractors
                    </label>
                    <textarea
                      id="ob-vendortypes"
                      rows={2}
                      className={inputClass}
                      value={text(program, "vendorTypes")}
                      onChange={(e) => setProgram({ ...program, vendorTypes: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ob-existing-reqs">
                      Existing insurance requirements
                    </label>
                    <textarea
                      id="ob-existing-reqs"
                      rows={2}
                      className={inputClass}
                      value={text(program, "existingRequirements")}
                      onChange={(e) =>
                        setProgram({ ...program, existingRequirements: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ob-tracking">
                      Current tracking method
                    </label>
                    <input
                      id="ob-tracking"
                      className={inputClass}
                      value={text(program, "currentTracking")}
                      onChange={(e) => setProgram({ ...program, currentTracking: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ob-painpoints">
                      Main compliance pain points
                    </label>
                    <textarea
                      id="ob-painpoints"
                      rows={2}
                      className={inputClass}
                      value={text(program, "painPoints")}
                      onChange={(e) => setProgram({ ...program, painPoints: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Projects</h2>
                  <p className="text-xs text-muted-foreground">
                    Optional — skip anything now and add it from Settings later.
                  </p>
                  <div>
                    <label className={labelClass} htmlFor="ob-projects">
                      Existing projects (one per line)
                    </label>
                    <textarea
                      id="ob-projects"
                      rows={3}
                      className={inputClass}
                      value={text(projects, "existingProjects")}
                      onChange={(e) =>
                        setProjects({ ...projects, existingProjects: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ob-proj-reqs">
                      Project-specific requirements
                    </label>
                    <textarea
                      id="ob-proj-reqs"
                      rows={2}
                      className={inputClass}
                      value={text(projects, "projectRequirements")}
                      onChange={(e) =>
                        setProjects({ ...projects, projectRequirements: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="ob-owners">
                      Project managers / internal owners
                    </label>
                    <textarea
                      id="ob-owners"
                      rows={2}
                      className={inputClass}
                      value={text(projects, "owners")}
                      onChange={(e) => setProjects({ ...projects, owners: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}

              {step === 4 ? (
                <div className="space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Vendors</h2>
                  <p className="text-sm text-muted-foreground">
                    Bring your vendors in the fastest way for you. You can do this now or after
                    launch — our team helps either way.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Link
                      to={routes.vendorCoiImport}
                      onClick={async (event) => {
                        event.preventDefault();
                        const href = event.currentTarget.href;
                        try {
                          await saveBeforeImport();
                          window.location.assign(href);
                        } catch {
                          // The shared inline error keeps the customer in context.
                        }
                      }}
                      aria-disabled={save.isPending}
                      className="focusable rounded-md border border-border bg-background p-4 hover:border-primary aria-disabled:pointer-events-none aria-disabled:opacity-60"
                    >
                      <p className="text-sm font-semibold text-foreground">Upload COIs</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        We read your certificates and create vendors, policies and dates
                        automatically.
                      </p>
                    </Link>
                    <Link
                      to={routes.vendorImport}
                      onClick={async (event) => {
                        event.preventDefault();
                        const href = event.currentTarget.href;
                        try {
                          await saveBeforeImport();
                          window.location.assign(href);
                        } catch {
                          // The shared inline error keeps the customer in context.
                        }
                      }}
                      aria-disabled={save.isPending}
                      className="focusable rounded-md border border-border bg-background p-4 hover:border-primary aria-disabled:pointer-events-none aria-disabled:opacity-60"
                    >
                      <p className="text-sm font-semibold text-foreground">Import a CSV</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Upload a vendor list and map projects, vendors and assignments.
                      </p>
                    </Link>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Prefer we migrate your list?{" "}
                    <span className="font-medium text-foreground">
                      Note it below and our team will handle it.
                    </span>
                  </p>
                  <textarea
                    aria-label="Migration assistance notes"
                    rows={2}
                    className={inputClass}
                    placeholder="e.g. our vendor list lives in Procore / a spreadsheet we can share"
                    value={text(projects, "migrationNotes")}
                    onChange={(e) => setProjects({ ...projects, migrationNotes: e.target.value })}
                  />
                </div>
              ) : null}

              {step === 5 ? (
                <div className="space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Requirements</h2>
                  <p className="text-sm text-muted-foreground">
                    Which coverages do you require from vendors? We&apos;ll build requirement
                    profiles from this. Optional — you can set these up later from Settings.
                  </p>
                  <fieldset className="grid gap-2 sm:grid-cols-2">
                    <legend className="sr-only">Required coverages</legend>
                    {COVERAGE_OPTIONS.map((option) => {
                      const checked = stringArray(requirements, "coverages").includes(option);
                      return (
                        <label
                          key={option}
                          className="flex items-center gap-2 rounded-sm border border-border bg-background px-3 py-2 text-sm text-foreground"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCoverage(option)}
                          />
                          {option}
                        </label>
                      );
                    })}
                  </fieldset>
                  <div>
                    <label className={labelClass} htmlFor="ob-other-endorsements">
                      Other required endorsements / documents
                    </label>
                    <textarea
                      id="ob-other-endorsements"
                      rows={2}
                      className={inputClass}
                      value={text(requirements, "other")}
                      onChange={(e) => setRequirements({ ...requirements, other: e.target.value })}
                    />
                  </div>
                </div>
              ) : null}

              {step === 6 ? (
                <div className="space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Review &amp; submit</h2>
                  <p className="text-sm text-muted-foreground">
                    When you submit, our compliance team validates your setup — vendors, requirement
                    profiles, projects and communication — then activates managed service. Your
                    workspace stays open throughout, and you can edit and resubmit until we launch.
                  </p>
                  <OnboardingReviewSummary sections={currentSections} onEditStep={setStep} />
                  {requiredMissing.length > 0 ? (
                    <p
                      role="alert"
                      className="rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
                    >
                      Add your company name before submitting — you can edit it on the Company step.
                    </p>
                  ) : null}
                  {submit.isError ? (
                    <p
                      role="alert"
                      className="rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
                    >
                      {submit.error instanceof Error
                        ? submit.error.message
                        : "Could not submit. Try again."}
                    </p>
                  ) : null}
                  {!live ? (
                    <p className="rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                      Demo mode — submitting is disabled without a database connected.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {save.isError || submit.isError ? (
                <div role="alert" className="mt-5 rounded-sm border border-destructive/30 bg-danger-soft px-3 py-2">
                  <p className="text-sm font-semibold text-destructive">We couldn&apos;t save that yet.</p>
                  <p className="mt-0.5 text-xs text-foreground">
                    Check your connection and try again. Your answers are still on this page.
                  </p>
                </div>
              ) : null}

              <div className="mt-6 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={step === 1 || save.isPending || submit.isPending}
                  className="focusable rounded-sm border border-input bg-card px-3 py-2 text-sm font-semibold text-foreground disabled:opacity-50"
                >
                  Back
                </button>
                {step < STEP_LABELS.length ? (
                  <div className="flex items-center gap-2">
                    {step !== 1 && stepIsEmpty(step, currentSections) ? (
                      <button
                        type="button"
                        onClick={() => void goNext()}
                        disabled={save.isPending}
                        className="focusable rounded-sm border border-input bg-card px-3 py-2 text-sm font-semibold text-muted-foreground disabled:opacity-60"
                      >
                        Skip for now
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void goNext()}
                      disabled={save.isPending}
                      className="focusable rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                    >
                      {save.isPending ? "Saving…" : "Continue"}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={submit.isPending || !live || requiredMissing.length > 0}
                    className="focusable rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                  >
                    {submit.isPending
                      ? submitted
                        ? "Resubmitting…"
                        : "Submitting…"
                      : submitted
                        ? "Save & resubmit"
                        : "Submit for review"}
                  </button>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
