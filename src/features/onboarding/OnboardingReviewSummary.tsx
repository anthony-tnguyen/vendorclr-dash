import {
  SECTION_DEFS,
  fieldDisplay,
  type WizardSections,
} from "@/features/onboarding/onboardingSections";

/**
 * Section-by-section review of the answers a customer chose to provide.
 * Optional blanks stay out of the summary so review feels like confirmation,
 * not a list of unfinished work.
 */
export function OnboardingReviewSummary({
  sections,
  onEditStep,
}: {
  sections: WizardSections;
  onEditStep: (step: number) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="rounded-sm border border-primary/20 bg-primary/[0.05] px-3 py-2 text-xs text-foreground">
        Review what you shared. Optional details can be added later from Settings.
      </p>

      {SECTION_DEFS.map((def) => {
        const providedFields = def.fields
          .map((field) => ({ field, display: fieldDisplay(sections, def, field) }))
          .filter(({ display }) => display.provided);

        return (
          <section
            key={`${def.step}-${def.title}`}
            className="rounded-md border border-border bg-card p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-foreground">{def.title}</h3>
              <button
                type="button"
                onClick={() => onEditStep(def.step)}
                className="focusable rounded-sm border border-input bg-card px-2.5 py-1 text-xs font-semibold text-foreground"
              >
                Edit
              </button>
            </div>
            {providedFields.length > 0 ? (
              <dl className="mt-2 space-y-1.5">
                {providedFields.map(({ field, display }) => (
                  <div key={field.key} className="grid gap-0.5 text-sm sm:grid-cols-[10rem_1fr] sm:gap-2">
                    <dt className="text-muted-foreground">
                      {field.label}
                      {field.required ? <span className="text-destructive"> *</span> : null}
                    </dt>
                    <dd className="text-foreground">{display.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">No details added — that&apos;s okay.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
