import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import { isBackendConfigured } from "@/data/repository";
import {
  REQUIREMENT_CATALOG,
  canEditRequirements,
  loadRequirementAuditHistory,
  loadRequirementSettings,
  ruleLabel,
  saveRequirementSettings,
  validateRequirementSettings,
  type RequirementAuditEntry,
  type RequirementRuleSpec,
  type RequirementSettingValue,
  type RequirementSettings,
} from "@/data/repositories/requirementSettings";

/**
 * Company insurance requirements.
 *
 * Writes go straight to requirement_profile_rules on the request-scoped client;
 * RLS restricts them to owner/risk_manager. Everything configured here uses the
 * same rule_key and configuration vocabulary the compliance engine evaluates a
 * submitted package against, so a change made on this page genuinely changes
 * what counts as compliant.
 *
 * Demo mode (no database configured) keeps the local-state behaviour and says
 * so; nothing is persisted there.
 */

const GROUP_ORDER: Array<{ id: RequirementRuleSpec["group"]; title: string; blurb: string }> = [
  {
    id: "coverage",
    title: "Coverage types and minimum limits",
    blurb: "Coverage a vendor must carry, and the lowest limit you will accept.",
  },
  {
    id: "endorsement",
    title: "Endorsements",
    blurb: "Protections the certificate must show for your company.",
  },
  {
    id: "certificate",
    title: "Certificate holder",
    blurb: "The certificate holder itself is set per project; this decides whether it is checked.",
  },
  {
    id: "document",
    title: "Required documents",
    blurb: "Paperwork a vendor must submit, beyond what the certificate states.",
  },
];

const DEMO_DEFAULT_KEYS = new Set([
  "general_liability_each_occurrence_limit",
  "general_liability_general_aggregate_limit",
  "workers_compensation_each_occurrence_limit",
  "general_liability_additional_insured",
  "general_liability_waiver_of_subrogation",
  "certificate_holder_named",
  "document_certificate_of_insurance",
]);

function demoSettings(): RequirementSettings {
  const values: Record<string, RequirementSettingValue> = {};
  for (const spec of REQUIREMENT_CATALOG) {
    const enabled = DEMO_DEFAULT_KEYS.has(spec.key);
    values[spec.key] = {
      enabled,
      amount: enabled && spec.hasAmount ? 2000000 : null,
    };
  }
  return { profileId: "demo", profileName: "Company default", values, customRules: [] };
}

function formatAmount(amount: number | null): string {
  return amount === null ? "—" : `$${amount.toLocaleString()}`;
}

function HistoryPanel({
  entries,
  unavailable,
}: {
  entries: RequirementAuditEntry[];
  unavailable: boolean;
}) {
  return (
    <section className="rounded-md border border-border bg-card p-4" aria-labelledby="history-h">
      <h2 id="history-h" className="text-sm font-semibold">
        Change history
      </h2>
      {unavailable || entries.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No requirement changes have been recorded yet. Saved changes appear here with the date and
          the values before and after.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {entries.map((entry) => (
            <li key={entry.id} className="text-xs text-muted-foreground">
              <span className="numeric">{new Date(entry.createdAt).toLocaleString()}</span>{" "}
              <span className="font-medium text-foreground">{ruleLabel(entry.ruleKey)}</span>{" "}
              {entry.action === "requirement_rule_removed"
                ? "was turned off"
                : entry.action === "requirement_rule_added"
                  ? `was turned on${entry.amount === null ? "" : ` at ${formatAmount(entry.amount)}`}`
                  : `changed${
                      entry.previousAmount !== null || entry.amount !== null
                        ? ` from ${formatAmount(entry.previousAmount)} to ${formatAmount(entry.amount)}`
                        : ""
                    }`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { companyId, companyRole } = useSession();
  const isLive = isBackendConfigured();
  const canEdit = isLive ? canEditRequirements(companyRole) : true;

  const [status, setStatus] = useState<"loading" | "ready" | "error">(isLive ? "loading" : "ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<RequirementSettings | null>(
    isLive ? null : demoSettings(),
  );
  const [values, setValues] = useState<Record<string, RequirementSettingValue>>(
    isLive ? {} : demoSettings().values,
  );
  const [history, setHistory] = useState<RequirementAuditEntry[]>([]);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isLive) return;
    if (!companyId) {
      setStatus("error");
      setLoadError("Your account is not linked to a company yet, so there is nothing to configure.");
      return;
    }
    setStatus("loading");
    setLoadError(null);
    try {
      const loaded = await loadRequirementSettings(companyId);
      setSettings(loaded);
      setValues(loaded.values);
      setStatus("ready");
      try {
        setHistory(await loadRequirementAuditHistory(companyId));
        setHistoryUnavailable(false);
      } catch {
        setHistoryUnavailable(true);
      }
    } catch (error) {
      setStatus("error");
      setLoadError(error instanceof Error ? error.message : "Could not load your requirements.");
    }
  }, [companyId, isLive]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!settings) return false;
    return REQUIREMENT_CATALOG.some((spec) => {
      const next = values[spec.key];
      const prev = settings.values[spec.key];
      return next?.enabled !== prev?.enabled || (next?.amount ?? null) !== (prev?.amount ?? null);
    });
  }, [settings, values]);

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
    if (!settings) return;

    const nextErrors = validateRequirementSettings(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setSaveError("Some requirements need attention before this can be saved.");
      return;
    }

    if (!isLive) {
      setSettings({ ...settings, values });
      setNotice("Demo mode: these requirements were not saved to any database.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await saveRequirementSettings(companyId!, settings, values);
      setSettings({ ...settings, values });
      setNotice("Requirements saved. New vendor submissions are evaluated against them.");
      try {
        setHistory(await loadRequirementAuditHistory(companyId!));
      } catch {
        setHistoryUnavailable(true);
      }
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save your requirements. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const subtitle = isLive
    ? "Coverage, endorsements and documents every vendor must satisfy."
    : "Demo mode — coverage and endorsement defaults are not saved anywhere.";

  return (
    <AppShell title="Insurance requirements" subtitle={subtitle}>
      {status === "loading" ? (
        <LoadingState label="Loading your requirements" />
      ) : status === "error" ? (
        <ErrorState description={loadError ?? "Could not load your requirements."} onRetry={() => void load()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <form onSubmit={onSubmit} className="space-y-4">
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
              return (
                <fieldset
                  key={group.id}
                  disabled={!canEdit || saving}
                  className="rounded-md border border-border bg-card p-4 disabled:opacity-70"
                >
                  <legend className="px-1 text-sm font-semibold">{group.title}</legend>
                  <p className="text-xs text-muted-foreground">{group.blurb}</p>
                  <ul className="mt-3 space-y-3">
                    {specs.map((spec) => {
                      const value = values[spec.key] ?? { enabled: false, amount: null };
                      const errorId = `${spec.key}-error`;
                      return (
                        <li
                          key={spec.key}
                          className="grid gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-start"
                        >
                          <div className="flex items-start gap-2">
                            <input
                              id={`req-${spec.key}`}
                              type="checkbox"
                              checked={value.enabled}
                              onChange={(event) =>
                                update(spec.key, {
                                  enabled: event.target.checked,
                                  amount:
                                    event.target.checked && spec.hasAmount
                                      ? (value.amount ?? null)
                                      : null,
                                })
                              }
                              className="focusable mt-0.5 size-4 rounded-sm border-input"
                            />
                            <div>
                              <label
                                htmlFor={`req-${spec.key}`}
                                className="text-sm font-medium leading-tight"
                              >
                                {spec.label}
                              </label>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {spec.description}
                              </p>
                            </div>
                          </div>

                          {spec.hasAmount ? (
                            <div>
                              <label
                                htmlFor={`amount-${spec.key}`}
                                className="block text-xs font-medium text-muted-foreground"
                              >
                                Minimum limit (USD)
                              </label>
                              <input
                                id={`amount-${spec.key}`}
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
                                      event.target.value === ""
                                        ? null
                                        : Number(event.target.value),
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

            {settings && settings.customRules.length > 0 ? (
              <section className="rounded-md border border-border bg-card p-4">
                <h2 className="text-sm font-semibold">Other rules on this profile</h2>
                <p className="text-xs text-muted-foreground">
                  Set up outside this page. They still apply and are left untouched when you save.
                </p>
                <ul className="mt-2 space-y-1">
                  {settings.customRules.map((rule) => (
                    <li key={rule.key} className="numeric text-xs text-muted-foreground">
                      {rule.key} — {rule.kind}
                      {rule.amount === null ? "" : ` — ${formatAmount(rule.amount)}`}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={!canEdit || saving || !dirty}
                className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save requirements"}
              </button>
              {dirty && !saving ? (
                <button
                  type="button"
                  onClick={() => {
                    setValues(settings?.values ?? {});
                    setErrors({});
                    setNotice(null);
                    setSaveError(null);
                  }}
                  className="focusable rounded-sm border border-input px-3 py-2 text-sm font-medium"
                >
                  Discard changes
                </button>
              ) : null}
            </div>

            {saveError ? (
              <p role="alert" className="rounded-sm border border-destructive/30 bg-danger-soft px-3 py-2 text-xs">
                {saveError}
              </p>
            ) : null}
            {notice ? (
              <p role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                {notice}
              </p>
            ) : null}
          </form>

          <div className="space-y-4">
            <section className="rounded-md border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Profile</h2>
              <p className="mt-1 text-sm">{settings?.profileName ?? "Company default"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Applied to every vendor assignment that does not use a project-specific profile.
              </p>
            </section>
            <HistoryPanel entries={history} unavailable={historyUnavailable || !isLive} />
          </div>
        </div>
      )}
    </AppShell>
  );
}
