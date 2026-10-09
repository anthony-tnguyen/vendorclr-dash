import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { useSession } from "@/app/App";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  REQUIREMENT_CATALOG,
  canEditRequirements,
  validateRequirementSettings,
  type RequirementRuleSpec,
  type RequirementSettingValue,
} from "@/data/repositories/requirementSettings";
import {
  loadVendorRequirementSettings,
  saveVendorRequirementSettings,
} from "@/data/repositories/vendorRequirements";

/**
 * Per-vendor requirement settings on the vendor detail page.
 *
 * Each requirement starts from the company default profile (the baseline a
 * vendor inherits) and can be selected/deselected — and, for coverage limits,
 * given a different minimum — for this one vendor. Only deviations from the
 * default are persisted (vendor_requirement_overrides), which
 * resolve_assignment_requirements() applies as the highest-precedence layer, so
 * these choices change what this vendor's submissions are evaluated against.
 *
 * Demo mode (no database configured) keeps the whole form in local state and
 * says nothing is saved — same discipline as the company Settings page.
 */

const GROUP_ORDER: Array<{ id: RequirementRuleSpec["group"]; title: string }> = [
  { id: "coverage", title: "Coverage types and minimum limits" },
  { id: "endorsement", title: "Endorsements" },
  { id: "certificate", title: "Certificate holder" },
  { id: "document", title: "Required documents" },
];

// A representative default so the demo panel is populated and interactive.
// Mirrors the company Settings page's demo defaults.
const DEMO_BASELINE_KEYS = new Set([
  "general_liability_each_occurrence_limit",
  "general_liability_general_aggregate_limit",
  "workers_compensation_each_occurrence_limit",
  "general_liability_additional_insured",
  "general_liability_waiver_of_subrogation",
  "certificate_holder_named",
  "document_certificate_of_insurance",
]);

function demoBaseline(): Record<string, RequirementSettingValue> {
  const values: Record<string, RequirementSettingValue> = {};
  for (const spec of REQUIREMENT_CATALOG) {
    const enabled = DEMO_BASELINE_KEYS.has(spec.key);
    values[spec.key] = { enabled, amount: enabled && spec.hasAmount ? 2000000 : null };
  }
  return values;
}

function cloneValues(
  source: Record<string, RequirementSettingValue>,
): Record<string, RequirementSettingValue> {
  const next: Record<string, RequirementSettingValue> = {};
  for (const spec of REQUIREMENT_CATALOG) {
    const value = source[spec.key] ?? { enabled: false, amount: null };
    next[spec.key] = { enabled: value.enabled, amount: value.amount };
  }
  return next;
}

export function VendorRequirementsPanel({ vendorId }: { vendorId: string }) {
  const { companyId, companyRole, mode } = useSession();
  const isLive = mode === "live";
  const canEdit = isLive ? canEditRequirements(companyRole) : true;

  const [status, setStatus] = useState<"loading" | "ready" | "error">(isLive ? "loading" : "ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Record<string, RequirementSettingValue>>(() =>
    isLive ? {} : demoBaseline(),
  );
  const [savedValues, setSavedValues] = useState<Record<string, RequirementSettingValue>>(() =>
    isLive ? {} : demoBaseline(),
  );
  const [values, setValues] = useState<Record<string, RequirementSettingValue>>(() =>
    isLive ? {} : demoBaseline(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isLive) return;
    if (!companyId) {
      setStatus("error");
      setLoadError("This workspace is not linked to a company yet.");
      return;
    }
    setStatus("loading");
    setLoadError(null);
    try {
      const loaded = await loadVendorRequirementSettings(companyId, vendorId);
      setBaseline(loaded.baseline);
      setSavedValues(loaded.values);
      setValues(cloneValues(loaded.values));
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setLoadError(
        error instanceof Error ? error.message : "Could not load this vendor's requirements.",
      );
    }
  }, [companyId, vendorId, isLive]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () =>
      REQUIREMENT_CATALOG.some((spec) => {
        const next = values[spec.key];
        const prev = savedValues[spec.key];
        return next?.enabled !== prev?.enabled || (next?.amount ?? null) !== (prev?.amount ?? null);
      }),
    [values, savedValues],
  );

  const update = (key: string, patch: Partial<RequirementSettingValue>) => {
    setNotice(null);
    setSaveError(null);
    setValues((current) => ({
      ...current,
      [key]: { enabled: false, amount: null, ...current[key], ...patch },
    }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextErrors = validateRequirementSettings(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setSaveError("Some requirements need attention before this can be saved.");
      return;
    }

    if (!isLive) {
      setSavedValues(cloneValues(values));
      setNotice("Demo mode: these per-vendor requirements were not saved to any database.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await saveVendorRequirementSettings(companyId!, vendorId, baseline, values);
      setSavedValues(cloneValues(values));
      setNotice("Saved. This vendor's submissions are now evaluated against these requirements.");
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Could not save this vendor's requirements. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const resetToDefault = () => {
    setNotice(null);
    setSaveError(null);
    setErrors({});
    setValues(cloneValues(baseline));
  };

  return (
    <section
      aria-labelledby="vendor-requirements-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="vendor-requirements-heading" className="text-sm font-semibold text-foreground">
            Vendor requirements
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {isLive
              ? "Select the coverage, endorsements and documents this vendor must satisfy. These override your company default for this vendor only."
              : "Demo mode — per-vendor requirements are not saved anywhere."}
          </p>
        </div>
      </div>

      {status === "loading" ? (
        <div className="mt-3">
          <LoadingState label="Loading vendor requirements" rows={4} />
        </div>
      ) : status === "error" ? (
        <div className="mt-3">
          <ErrorState
            description={loadError ?? "Could not load this vendor's requirements."}
            onRetry={() => void load()}
          />
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-3 space-y-4">
          {!canEdit ? (
            <p
              role="note"
              className="rounded-sm border border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
            >
              You can view these requirements. Only an owner or risk manager can change them.
            </p>
          ) : null}

          {GROUP_ORDER.map((group) => {
            const specs = REQUIREMENT_CATALOG.filter((spec) => spec.group === group.id);
            if (specs.length === 0) return null;
            return (
              <fieldset
                key={group.id}
                disabled={!canEdit || saving}
                className="rounded-sm border border-border p-3 disabled:opacity-70"
              >
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </legend>
                <ul className="mt-2 space-y-3">
                  {specs.map((spec) => {
                    const value = values[spec.key] ?? { enabled: false, amount: null };
                    const base = baseline[spec.key] ?? { enabled: false, amount: null };
                    const overridden =
                      value.enabled !== base.enabled ||
                      (spec.hasAmount &&
                        value.enabled &&
                        (value.amount ?? null) !== (base.amount ?? null));
                    const errorId = `vendor-${spec.key}-error`;
                    return (
                      <li
                        key={spec.key}
                        className="grid gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-start"
                      >
                        <div className="flex items-start gap-2">
                          <input
                            id={`vendor-req-${spec.key}`}
                            type="checkbox"
                            checked={value.enabled}
                            onChange={(event) =>
                              update(spec.key, {
                                enabled: event.target.checked,
                                amount:
                                  event.target.checked && spec.hasAmount
                                    ? (value.amount ?? base.amount ?? null)
                                    : null,
                              })
                            }
                            className="focusable mt-0.5 size-4 rounded-sm border-input"
                          />
                          <div className="min-w-0">
                            <label
                              htmlFor={`vendor-req-${spec.key}`}
                              className="flex flex-wrap items-center gap-2 text-sm font-medium leading-tight"
                            >
                              {spec.label}
                              {overridden ? (
                                <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                                  Custom
                                </span>
                              ) : null}
                            </label>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {spec.description}
                            </p>
                          </div>
                        </div>

                        {spec.hasAmount ? (
                          <div>
                            <label
                              htmlFor={`vendor-amount-${spec.key}`}
                              className="block text-xs font-medium text-muted-foreground"
                            >
                              Minimum limit (USD)
                            </label>
                            <input
                              id={`vendor-amount-${spec.key}`}
                              type="number"
                              inputMode="numeric"
                              min={0}
                              step={100000}
                              disabled={!value.enabled}
                              value={value.amount ?? ""}
                              aria-invalid={errors[spec.key] ? true : undefined}
                              aria-describedby={errors[spec.key] ? errorId : undefined}
                              onChange={(event) =>
                                update(spec.key, {
                                  amount:
                                    event.target.value === "" ? null : Number(event.target.value),
                                })
                              }
                              className="numeric focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
                            />
                            {errors[spec.key] ? (
                              <p id={errorId} className="mt-1 text-xs text-destructive">
                                {errors[spec.key]}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            );
          })}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!canEdit || saving || !dirty}
              className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save vendor requirements"}
            </button>
            {canEdit && dirty && !saving ? (
              <button
                type="button"
                onClick={() => {
                  setValues(cloneValues(savedValues));
                  setErrors({});
                  setNotice(null);
                  setSaveError(null);
                }}
                className="focusable rounded-sm border border-input px-3 py-2 text-sm font-medium"
              >
                Discard changes
              </button>
            ) : null}
            {canEdit && !saving ? (
              <button
                type="button"
                onClick={resetToDefault}
                className="focusable rounded-sm border border-input px-3 py-2 text-sm font-medium"
              >
                Reset to company default
              </button>
            ) : null}
          </div>

          {saveError ? (
            <p
              role="alert"
              className="rounded-sm border border-destructive/30 bg-danger-soft px-3 py-2 text-xs"
            >
              {saveError}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
              {notice}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
