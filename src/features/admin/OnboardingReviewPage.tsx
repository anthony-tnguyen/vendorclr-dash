import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { OnboardingReview } from "@/data/contracts";
import { getRepository } from "@/data/repository";
import { planLabel } from "@/domain/billing/plans";

/**
 * Step 6 of onboarding — the staff side.
 *
 * Lists every company still in onboarding / in_review with the answers the
 * customer gave in the wizard, so a VendorClr specialist can validate the setup
 * (vendors, requirement profiles, projects) and then launch the workspace. The
 * "Launch" action calls set_company_service_status(company, 'live'), which is
 * the gate AppShell reads to open the console and close the customer's waiting
 * screen. Staff-only; RLS returns no rows to a non-staff caller and AdminGuard
 * hides the screen from the wrong demo role.
 */

const FIELD_LABELS: Record<string, string> = {
  // Step 1 — company
  companyName: "Company name",
  primaryContact: "Primary contact",
  industry: "Industry",
  location: "Location",
  approxVendors: "Approx. active vendors",
  // Step 2 — compliance program
  vendorTypes: "Vendor / subcontractor types",
  existingRequirements: "Existing insurance requirements",
  currentTracking: "Current tracking method",
  painPoints: "Main pain points",
  // Step 3 — projects
  existingProjects: "Existing projects",
  projectRequirements: "Project-specific requirements",
  owners: "Project managers / owners",
  migrationNotes: "Migration notes",
  // Step 5 — requirements
  coverages: "Required coverages",
  other: "Other endorsements / documents",
};

function displayValue(value: unknown): string {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.filter((v) => v != null && v !== "").join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function label(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

function AnswerSection({ title, answers }: { title: string; answers: Record<string, unknown> }) {
  const entries = Object.entries(answers)
    .map(([key, value]) => [key, displayValue(value)] as const)
    .filter(([, value]) => value !== "");

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Not provided yet.</p>
      ) : (
        <dl className="mt-1 space-y-1.5">
          {entries.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
              <dt className="text-muted-foreground">{label(key)}</dt>
              <dd className="whitespace-pre-line text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: OnboardingReview["serviceStatus"] }) {
  const submitted = status === "in_review";
  return (
    <span
      className={
        submitted
          ? "rounded-sm border border-primary/30 bg-primary/[0.07] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary"
          : "rounded-sm border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
      }
    >
      {submitted ? "Submitted — awaiting review" : "In progress"}
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ReviewCard({
  review,
  onLaunch,
  launching,
}: {
  review: OnboardingReview;
  onLaunch: (companyId: string) => void;
  launching: boolean;
}) {
  // A workspace may only be launched once the customer has finished the wizard:
  // service_status 'in_review' with a submitted_at. The RPC enforces the same
  // precondition server-side; this disables the control so staff never fire a
  // request the database will reject. A company still 'in progress' is not
  // launchable from here.
  const launchReady = review.serviceStatus === "in_review" && Boolean(review.submittedAt);
  return (
    <article className="space-y-4 rounded-md border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">{review.companyName}</h3>
            <StatusBadge status={review.serviceStatus} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {planLabel(review.plan)} · {review.activeVendors} active vendors · step{" "}
            {review.currentStep} · submitted {formatDate(review.submittedAt)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={() => onLaunch(review.companyId)}
            disabled={launching || !launchReady}
            title={
              launchReady
                ? undefined
                : "Only companies that have submitted the wizard (awaiting review) can be launched."
            }
            className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {launching ? "Launching…" : "Launch — set live"}
          </button>
          {!launchReady ? (
            <p className="text-[11px] text-muted-foreground">Waiting on the customer to submit</p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <AnswerSection title="Company" answers={review.companyInfo} />
        <AnswerSection title="Compliance program" answers={review.program} />
        <AnswerSection title="Projects" answers={review.projects} />
        <AnswerSection title="Requirements" answers={review.requirements} />
      </div>
    </article>
  );
}

export function OnboardingReviewPage() {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const reviews = useQuery({
    queryKey: ["admin", "onboarding-reviews"],
    queryFn: () => repo.listOnboardingReviews(),
  });

  const launch = useMutation({
    mutationFn: (companyId: string) => repo.setCompanyServiceStatus(companyId, "live"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "onboarding-reviews"] });
    },
  });

  function onLaunch(companyId: string) {
    const review = (reviews.data ?? []).find((r) => r.companyId === companyId);
    const name = review?.companyName ?? "this company";
    // A one-way, customer-visible transition (their console opens), so confirm.
    if (!window.confirm(`Launch ${name}? This opens their console and starts managed service.`)) {
      return;
    }
    launch.mutate(companyId);
  }

  return (
    <AppShell
      title="Onboarding review"
      subtitle="Validate each new company's setup, then launch their workspace."
    >
      <AdminGuard>
        {reviews.isLoading ? (
          <LoadingState label="Loading onboarding reviews" rows={4} />
        ) : reviews.isError ? (
          <ErrorState
            description="Onboarding reviews could not be loaded."
            onRetry={() => void reviews.refetch()}
          />
        ) : (reviews.data ?? []).length === 0 ? (
          <EmptyState
            title="No companies awaiting launch"
            description="Companies in onboarding or under review appear here for the Step 6 validation."
          />
        ) : (
          <div className="space-y-4">
            {launch.isError ? (
              <p
                role="alert"
                className="rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
              >
                {launch.error instanceof Error
                  ? launch.error.message
                  : "Could not launch that workspace."}
              </p>
            ) : null}
            {(reviews.data ?? []).map((review) => (
              <ReviewCard
                key={review.companyId}
                review={review}
                onLaunch={onLaunch}
                launching={launch.isPending && launch.variables === review.companyId}
              />
            ))}
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
