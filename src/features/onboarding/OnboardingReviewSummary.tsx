import {
  SECTION_DEFS,
  fieldDisplay,
  missingCount,
  type WizardSections,
} from "@/features/onboarding/onboardingSections";

/**
 * Section-by-section review of the onboarding answers, with an edit link per
 * section and an explicit "Not provided" for every blank field. Shared by the
 * wizard's Review step and the under-review setup screen so a customer sees the
 * same picture whether they are submitting or correcting after submission.
 */
export function OnboardingReviewSummary({
  sections,
  onEditStep,
}: {
  sections: WizardSections;
  onEditStep: (step: number) => void;
}) {
  const missing = missingCount(sections);

  return (
    <div className="space-y-4">
      {missing > 0 ? (
        <p className="rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          {missing} {missing === 1 ? "item is" : "items are"} unanswered. You can submit now and
          finish these yourself later from Settings, or fill them in below.
        </p>
      ) : (
        <p className="rounded-sm border border-ok/40 bg-ok-soft px-3 py-2 text-xs text-ok">
          Everything is filled in.
        </p>
      )}

      {SECTION_DEFS.map((def) => (
        <section key={`${def.step}-${def.title}`} className="rounded-md border border-border bg-card p-4">
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
          <dl className="mt-2 space-y-1.5">
            {def.fields.map((field) => {
              const { value, provided } = fieldDisplay(sections, def, field);
              return (
                <div key={field.key} className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
                  <dt className="text-muted-foreground">
                    {field.label}
                    {field.required ? <span className="text-destructive"> *</span> : null}
                  </dt>
                  <dd className={provided ? "text-foreground" : "italic text-muted-foreground"}>
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}
