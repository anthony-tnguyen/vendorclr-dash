import { useState, type FormEvent } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { COMPLIANCE_LABELS, type ComplianceKey } from "@/data/contracts";

const requirementKeys: ComplianceKey[] = [
  "coi",
  "additionalInsured",
  "waiverOfSubrogation",
  "lienWaiver",
  "renewal",
];

export function SettingsPage() {
  const [notice, setNotice] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("Demo mode: settings were not saved to any backend.");
  };

  return (
    <AppShell title="Settings" subtitle="Requirement defaults and notification contacts.">
      <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-2">
        <fieldset className="rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-sm font-semibold">Required documents</legend>
          <p className="text-xs text-muted-foreground">
            Applied to every new vendor added to the roster.
          </p>
          <ul className="mt-3 space-y-2">
            {requirementKeys.map((key) => (
              <li key={key} className="flex items-center gap-2">
                <input
                  id={`req-${key}`}
                  type="checkbox"
                  defaultChecked
                  className="focusable size-4 rounded-sm border-input"
                />
                <label htmlFor={`req-${key}`} className="text-sm">
                  {COMPLIANCE_LABELS[key]}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <fieldset className="rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-sm font-semibold">Limits and reminders</legend>
          <div className="mt-2 space-y-3">
            <div>
              <label htmlFor="gl-limit" className="block text-sm font-medium">
                Minimum general liability per occurrence (USD)
              </label>
              <input
                id="gl-limit"
                type="number"
                defaultValue={2000000}
                step={100000}
                className="numeric focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="reminder-days" className="block text-sm font-medium">
                Renewal reminder lead time (days)
              </label>
              <input
                id="reminder-days"
                type="number"
                defaultValue={30}
                min={1}
                className="numeric focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="notify-email" className="block text-sm font-medium">
                Notification recipient
              </label>
              <input
                id="notify-email"
                type="email"
                defaultValue="risk@halstead.example"
                className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Demo-only: no reminder email is ever sent from this environment.
              </p>
            </div>
          </div>
        </fieldset>

        <div className="lg:col-span-2">
          <button
            type="submit"
            className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            Save settings (demo)
          </button>
          {notice ? (
            <p
              role="status"
              className="mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-xs"
            >
              {notice}
            </p>
          ) : null}
        </div>
      </form>
    </AppShell>
  );
}
