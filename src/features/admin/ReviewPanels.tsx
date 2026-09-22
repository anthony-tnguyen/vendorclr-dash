import { useState } from "react";

import type { ExtractionRevision, ReviewQueueItemDetail } from "@/workflows/documentReview";
import type { ExtractionChange } from "@/workflows/extractionDiff";
import {
  InsuranceExtractionSchema,
  POLICY_TYPES,
  type ExtractedPolicy,
  type InsuranceExtraction,
} from "@/workflows/insuranceExtractionSchema";

/**
 * Document review panels added for the pilot: requirement shortfalls, the
 * immutable extraction revision history (model attempts + reviewer
 * revisions) with a field-level "reviewer changes" view, a field editor that
 * saves a NEW reviewer revision (saveExtractionEdit), and the review's audit
 * history. Staff-only, like the page that hosts them.
 */

function formatLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const HISTORY_LABELS: Record<string, string> = {
  review_resolved: "Review decided",
  extraction_reviewer_edit: "Reviewer revision saved",
  document_reprocessed: "Document reprocessed",
};

export function Shortfalls({ shortfalls }: { shortfalls: ReviewQueueItemDetail["shortfalls"] }) {
  return (
    <section
      aria-labelledby="review-shortfalls"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="review-shortfalls" className="text-sm font-semibold text-foreground">
        Requirement shortfalls
      </h2>
      {shortfalls.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This vendor has no open deficiencies against its project requirements.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border text-sm" data-testid="review-shortfalls">
          {shortfalls.map((s) => (
            <li key={s.id} className="py-2">
              <p className="font-medium">
                {formatLabel(s.requirementKey)}
                {s.projectName ? (
                  <span className="font-normal text-muted-foreground"> · {s.projectName}</span>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">{s.explanation}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ExtractionRevisions({
  revisions,
  changes,
}: {
  revisions: ExtractionRevision[];
  changes: ExtractionChange[];
}) {
  const current = revisions.find((r) => r.current);
  return (
    <section
      aria-labelledby="review-revisions"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="review-revisions" className="text-sm font-semibold text-foreground">
        Extraction revisions
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Each model attempt and reviewer correction is kept as its own record. A correction never
        overwrites the model's extraction.
      </p>
      <ol className="mt-3 space-y-1 text-sm" data-testid="extraction-revisions">
        {revisions.map((r, index) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="numeric text-xs text-muted-foreground">{index + 1}.</span>
            <span className="font-medium">
              {r.source === "model" ? "Model extraction" : "Reviewer revision"}
            </span>
            <span className="text-xs text-muted-foreground">
              {r.source === "model"
                ? [r.model, r.confidence !== null ? `confidence ${r.confidence}` : null]
                    .filter(Boolean)
                    .join(" · ")
                : (r.reviewerEmail ?? "reviewer")}
              {" · "}
              {new Date(r.createdAt).toLocaleString()}
            </span>
            {r.error ? <span className="text-xs text-destructive">{r.error}</span> : null}
            {r.current ? (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-semibold">
                Current
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {current?.source === "reviewer_edit" ? (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Reviewer changes from the model extraction
          </h3>
          {changes.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              The current revision matches the model's extraction field for field.
            </p>
          ) : (
            <table className="mt-2 w-full text-left text-sm" data-testid="reviewer-changes">
              <caption className="sr-only">Fields the reviewer changed</caption>
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Field
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Model
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Reviewer
                  </th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.field} className="border-t border-border">
                    <th scope="row" className="py-1.5 pr-3 font-medium">
                      {c.field}
                    </th>
                    <td className="py-1.5 pr-3 text-muted-foreground line-through">{c.before}</td>
                    <td className="py-1.5 font-medium">{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function ReviewHistory({ history }: { history: ReviewQueueItemDetail["history"] }) {
  return (
    <section
      aria-labelledby="review-history"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="review-history" className="text-sm font-semibold text-foreground">
        Review history
      </h2>
      {history.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No review actions recorded yet.</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm" data-testid="review-history">
          {history.map((h) => (
            <li key={h.id}>
              <span className="font-medium">
                {HISTORY_LABELS[h.action] ?? formatLabel(h.action)}
              </span>
              <span className="text-xs text-muted-foreground">
                {" "}
                · {h.actorEmail ?? "system"} · {new Date(h.createdAt).toLocaleString()}
              </span>
              {h.note ? <p className="text-xs text-muted-foreground">{h.note}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Field editor
// ---------------------------------------------------------------------------

type TriState = "yes" | "no" | "unknown";
const toTri = (v: boolean | null | undefined): TriState =>
  v === true ? "yes" : v === false ? "no" : "unknown";
const fromTri = (v: TriState): boolean | null => (v === "yes" ? true : v === "no" ? false : null);

function nullIfBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function numberOrNull(value: string): number | null {
  const trimmed = value.replace(/[$,\s]/g, "");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

const inputClass =
  "focusable mt-1 w-full rounded-sm border border-input bg-background px-2 py-1 text-sm font-normal";

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date";
}) {
  return (
    <label className="block text-xs font-semibold text-foreground">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
    </label>
  );
}

function TriField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null | undefined;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <label className="block text-xs font-semibold text-foreground">
      {label}
      <select
        value={toTri(value)}
        onChange={(e) => onChange(fromTri(e.target.value as TriState))}
        className={inputClass}
      >
        <option value="unknown">Not confirmed</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
}

export function ExtractionEditor({
  value,
  saving,
  saved,
  error,
  onSave,
  onChange,
}: {
  value: InsuranceExtraction;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSave: (value: InsuranceExtraction) => void;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<InsuranceExtraction>(() => structuredClone(value));
  const [invalid, setInvalid] = useState<string | null>(null);

  const update = (next: InsuranceExtraction) => {
    setDraft(next);
    setInvalid(null);
    onChange();
  };
  const updatePolicy = (index: number, patch: Partial<ExtractedPolicy>) =>
    update({
      ...draft,
      policies: draft.policies.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    });

  return (
    <section aria-labelledby="review-edit" className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="review-edit" className="text-sm font-semibold text-foreground">
          Edit extracted fields
        </h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="focusable rounded-sm border border-border px-2 py-1.5 text-xs font-medium"
        >
          {open ? "Close editor" : "Correct extraction"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Saving creates a new reviewer revision attributed to you. The model's extraction is kept
        unchanged, and an approval applies the current revision.
      </p>
      {saved ? (
        <p role="status" className="mt-2 text-xs font-semibold text-ok">
          Saved as a new reviewer revision. The model's original extraction is unchanged.
        </p>
      ) : null}

      {open ? (
        <form
          aria-label="Edit extracted fields"
          className="mt-3 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = InsuranceExtractionSchema.safeParse(draft);
            if (!parsed.success) {
              setInvalid(parsed.error.issues[0]?.message ?? "Some fields are not valid.");
              return;
            }
            onSave(parsed.data);
          }}
        >
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Parties
            </legend>
            <TextField
              label="Insured name"
              value={draft.insured.name ?? ""}
              onChange={(v) =>
                update({ ...draft, insured: { ...draft.insured, name: nullIfBlank(v) } })
              }
            />
            <TextField
              label="Certificate holder"
              value={draft.certificate_holder.name ?? ""}
              onChange={(v) =>
                update({
                  ...draft,
                  certificate_holder: { ...draft.certificate_holder, name: nullIfBlank(v) },
                })
              }
            />
            <div className="sm:col-span-2">
              <TextField
                label="Certificate holder address"
                value={draft.certificate_holder.address ?? ""}
                onChange={(v) =>
                  update({
                    ...draft,
                    certificate_holder: { ...draft.certificate_holder, address: nullIfBlank(v) },
                  })
                }
              />
            </div>
          </fieldset>

          {draft.policies.map((policy, index) => (
            <fieldset key={index} className="grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Policy {index + 1}
              </legend>
              <label className="block text-xs font-semibold text-foreground">
                Coverage type
                <select
                  value={policy.type ?? ""}
                  onChange={(e) =>
                    updatePolicy(index, {
                      type:
                        e.target.value === "" ? null : (e.target.value as ExtractedPolicy["type"]),
                    })
                  }
                  className={inputClass}
                >
                  <option value="">Unclassified</option>
                  {POLICY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {formatLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
              <TextField
                label="Carrier"
                value={policy.carrier ?? ""}
                onChange={(v) => updatePolicy(index, { carrier: nullIfBlank(v) })}
              />
              <TextField
                label="Policy number"
                value={policy.policy_number ?? ""}
                onChange={(v) => updatePolicy(index, { policy_number: nullIfBlank(v) })}
              />
              <TextField
                label="Effective date"
                type="date"
                value={policy.effective_date ?? ""}
                onChange={(v) => updatePolicy(index, { effective_date: nullIfBlank(v) })}
              />
              <TextField
                label="Expiration date"
                type="date"
                value={policy.expiration_date ?? ""}
                onChange={(v) => updatePolicy(index, { expiration_date: nullIfBlank(v) })}
              />
              <TextField
                label="Each occurrence limit"
                value={policy.limits.each_occurrence?.toString() ?? ""}
                onChange={(v) =>
                  updatePolicy(index, {
                    limits: { ...policy.limits, each_occurrence: numberOrNull(v) },
                  })
                }
              />
              <TextField
                label="General aggregate limit"
                value={policy.limits.general_aggregate?.toString() ?? ""}
                onChange={(v) =>
                  updatePolicy(index, {
                    limits: { ...policy.limits, general_aggregate: numberOrNull(v) },
                  })
                }
              />
              <TriField
                label="Additional insured"
                value={policy.additional_insured}
                onChange={(v) => updatePolicy(index, { additional_insured: v })}
              />
              <TriField
                label="Waiver of subrogation"
                value={policy.waiver_of_subrogation}
                onChange={(v) => updatePolicy(index, { waiver_of_subrogation: v })}
              />
              <TriField
                label="Primary & non-contributory"
                value={policy.primary_noncontributory}
                onChange={(v) => updatePolicy(index, { primary_noncontributory: v })}
              />
            </fieldset>
          ))}

          {invalid ? (
            <p role="alert" className="text-xs font-semibold text-destructive">
              {invalid}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs font-semibold text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving}
              className="focusable rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save reviewer revision"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => update(structuredClone(value))}
              className="focusable rounded-sm border border-border px-3 py-2 text-xs font-semibold"
            >
              Discard changes
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
