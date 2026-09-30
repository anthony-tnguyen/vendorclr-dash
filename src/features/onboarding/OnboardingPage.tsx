import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { useSession } from "@/app/App";
import { routes } from "@/app/router";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { OnboardingPatch, OnboardingState } from "@/data/contracts";
import { getRepository, isBackendConfigured } from "@/data/repository";
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

type Section = Record<string, unknown>;

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

function Header({ personName, onSignOut }: { personName: string; onSignOut: () => void }) {
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
    </header>
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

function WaitingScreen({ companyName }: { companyName: string }) {
  return (
    <section className="rounded-md border border-border bg-card p-6">
      <h2 className="text-base font-bold tracking-tight text-foreground">
        Thanks — your setup is with our team
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        We&apos;ve received {companyName || "your"} onboarding details. A VendorClr specialist is
        validating your vendors, requirement profiles and project setup. Your console opens
        automatically once we&apos;ve confirmed everything and started managed service — you
        don&apos;t need to do anything else.
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        You can close this tab; we&apos;ll email you when your workspace is live.
      </p>
    </section>
  );
}

export function OnboardingPage() {
  const { personName, companyName, serviceStatus, signOut, refresh } = useSession();
  const repo = useMemo(() => getRepository(), []);
  const queryClient = useQueryClient();

  const onboarding = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => repo.getOnboarding(),
  });

  const [step, setStep] = useState(1);
  const [companyInfo, setCompanyInfo] = useState<Section>({});
  const [program, setProgram] = useState<Section>({});
  const [projects, setProjects] = useState<Section>({});
  const [requirements, setRequirements] = useState<Section>({});
  const [seeded, setSeeded] = useState(false);

  // Seed local form state once from whatever was saved, so a returning customer
  // resumes where they left off.
  useEffect(() => {
    if (seeded || onboarding.data === undefined) return;
    const loaded: OnboardingState | null = onboarding.data;
    if (loaded) {
      setCompanyInfo(loaded.companyInfo ?? {});
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

  function sectionForStep(target: number): OnboardingPatch {
    switch (target) {
      case 1:
        return { companyInfo };
      case 2:
        return { program };
      case 3:
        return { projects };
      case 5:
        return { requirements };
      default:
        return {};
    }
  }

  async function goNext() {
    const patch = { ...sectionForStep(step), currentStep: Math.min(step + 1, STEP_LABELS.length) };
    if (live) await save.mutateAsync(patch);
    else await repo.saveOnboarding(patch);
    setStep((s) => Math.min(s + 1, STEP_LABELS.length));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
  }

  async function onSubmit() {
    // Persist the last edited section before submitting.
    await repo.saveOnboarding({ ...sectionForStep(step), currentStep: STEP_LABELS.length });
    await submit.mutateAsync();
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
      <Header personName={personName} onSignOut={() => void signOut()} />
      <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6">
        {onboarding.isPending ? (
          <LoadingState label="Loading your onboarding" rows={4} />
        ) : onboarding.isError ? (
          <ErrorState description="Your onboarding could not be loaded. Nothing was changed." />
        ) : submitted ? (
          <WaitingScreen companyName={companyName} />
        ) : (
          <>
            <div className="space-y-3">
              <h1 className="text-lg font-bold tracking-tight text-foreground">
                Set up {companyName || "your workspace"}
              </h1>
              <p className="text-sm text-muted-foreground">
                A few details so our compliance team can start collecting and reviewing vendor
                insurance for you. You can change any of this later.
              </p>
              <Stepper step={step} />
            </div>

            <section className="rounded-md border border-border bg-card p-5">
              {step === 1 ? (
                <div className="space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Company</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelClass} htmlFor="ob-company">
                        Company name
                      </label>
                      <input
                        id="ob-company"
                        className={inputClass}
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
                      className="focusable rounded-md border border-border bg-background p-4 hover:border-primary"
                    >
                      <p className="text-sm font-semibold text-foreground">Upload COIs</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        We read your certificates and create vendors, policies and dates
                        automatically.
                      </p>
                    </Link>
                    <Link
                      to={routes.vendorImport}
                      className="focusable rounded-md border border-border bg-background p-4 hover:border-primary"
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
                    profiles from this.
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
                    profiles, projects and communication — then activates managed service and opens
                    your console.
                  </p>
                  <dl className="grid gap-2 text-sm">
                    <div className="flex justify-between gap-4 border-b border-border py-1.5">
                      <dt className="text-muted-foreground">Company</dt>
                      <dd className="text-foreground">{text(companyInfo, "companyName") || "—"}</dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-border py-1.5">
                      <dt className="text-muted-foreground">Primary contact</dt>
                      <dd className="text-foreground">
                        {text(companyInfo, "primaryContact") || "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-border py-1.5">
                      <dt className="text-muted-foreground">Required coverages</dt>
                      <dd className="text-foreground">
                        {stringArray(requirements, "coverages").length || 0} selected
                      </dd>
                    </div>
                  </dl>
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
                  <button
                    type="button"
                    onClick={() => void goNext()}
                    disabled={save.isPending}
                    className="focusable rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                  >
                    {save.isPending ? "Saving…" : "Save & continue"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={submit.isPending || !live}
                    className="focusable rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                  >
                    {submit.isPending ? "Submitting…" : "Submit for review"}
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
