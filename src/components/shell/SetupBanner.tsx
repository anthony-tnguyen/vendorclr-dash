import { Link } from "@tanstack/react-router";

import { routes } from "@/app/router";
import type { CompanyServiceStatus } from "@/data/dbTypeAliases";
import { CONTACT_EMAIL } from "@/features/legal/LegalPages";

/**
 * Persistent setup banner shown in the console while a paid workspace is still
 * being set up (service_status onboarding / in_review). It replaces the old
 * dead-end: the customer is now in their real dashboard and this is how they get
 * back to finish or correct the setup, or reach a human. It never shows once the
 * workspace is live, nor to staff.
 */
export function SetupBanner({ serviceStatus }: { serviceStatus: CompanyServiceStatus }) {
  const inReview = serviceStatus === "in_review";

  return (
    <section
      aria-labelledby="setup-banner-heading"
      className="mb-5 rounded-md border border-warn/40 bg-warn-soft p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="setup-banner-heading" className="text-sm font-bold text-warn">
            {inReview ? "Workspace setup is under review" : "Finish setting up your workspace"}
          </h2>
          <p className="mt-1 text-xs text-foreground">
            {inReview
              ? "Your details are with our compliance team. You can keep working here and edit your setup until we launch managed service — we'll only start sending to vendors once your workspace is live."
              : "You have full access to your workspace. Finish the guided setup so our compliance team can validate it and turn on managed service."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={routes.onboarding}
            className="focusable rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
          >
            {inReview ? "Review setup" : "Resume setup"}
          </Link>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="focusable rounded-sm border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground"
          >
            Contact VendorClr
          </a>
        </div>
      </div>
    </section>
  );
}
