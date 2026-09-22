import { useEffect, useState } from "react";
import {
  REQUIREMENT_CATALOG,
  loadRequirementProfileSettings,
  saveRequirementSettings,
  validateRequirementSettings,
  type RequirementSettingValue,
  type RequirementSettings,
} from "@/data/repositories/requirementSettings";

export function RequirementProfileRulesEditor({
  companyId,
  profileId,
}: {
  companyId: string;
  profileId: string;
}) {
  const [settings, setSettings] = useState<RequirementSettings | null>(null);
  const [values, setValues] = useState<Record<string, RequirementSettingValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void loadRequirementProfileSettings(companyId, profileId)
      .then((value) => {
        setSettings(value);
        setValues(value.values);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Could not load profile rules."),
      );
  }, [companyId, profileId]);
  if (error)
    return (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    );
  if (!settings) return <p className="text-xs text-muted-foreground">Loading profile rules…</p>;
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const errors = validateRequirementSettings(values);
        if (Object.keys(errors).length) {
          setError("Fix invalid requirement amounts before saving.");
          return;
        }
        setSaving(true);
        setError(null);
        try {
          await saveRequirementSettings(companyId, settings, values);
          setSettings({ ...settings, values });
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Could not save profile rules.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="text-xs text-muted-foreground">
        Rules use the same catalog and validation as Company Settings. Unknown stored rules are
        retained.
      </p>
      {REQUIREMENT_CATALOG.map((spec) => {
        const value = values[spec.key] ?? { enabled: false, amount: null };
        return (
          <label
            key={spec.key}
            className="grid gap-2 border-b border-border/60 py-2 text-sm sm:grid-cols-[1fr_10rem]"
          >
            <span>
              <input
                type="checkbox"
                checked={value.enabled}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [spec.key]: {
                      enabled: event.target.checked,
                      amount: event.target.checked ? value.amount : null,
                    },
                  }))
                }
                className="mr-2"
              />
              {spec.label}
            </span>
            {spec.hasAmount ? (
              <input
                type="number"
                min={0}
                step={100000}
                disabled={!value.enabled}
                value={value.amount ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [spec.key]: {
                      enabled: value.enabled,
                      amount: event.target.value === "" ? null : Number(event.target.value),
                    },
                  }))
                }
                className="focusable rounded-sm border border-input bg-background px-2 py-1"
                aria-label={`${spec.label} minimum limit`}
              />
            ) : (
              <span className="text-xs text-muted-foreground">{spec.group}</span>
            )}
          </label>
        );
      })}
      {settings.customRules.length ? (
        <p className="text-xs text-muted-foreground">
          Other preserved rules: {settings.customRules.map((rule) => rule.key).join(", ")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={saving}
        className="focusable rounded-sm border border-border px-3 py-2 text-sm"
      >
        {saving ? "Saving…" : "Save rules"}
      </button>
    </form>
  );
}
