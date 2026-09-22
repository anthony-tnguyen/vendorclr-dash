import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { getSupabaseClient } from "@/lib/supabase/client";
import {
  DEFICIENCY_STATUS_LABELS,
  escalationLabel,
  requiredVsSubmitted,
  requirementHeadline,
} from "@/domain/compliance/deficiencyDisplay";
import { generateCorrectionInstruction } from "@/domain/compliance/cases";
import {
  approveException,
  getAssignmentCompliance,
  getVendorCompliance,
  requestCorrection,
  type ComplianceCaseView,
  type DeficiencyView,
} from "@/workflows/complianceCases";
import {
  getCommunicationHistory,
  getVendorContactsPanel,
  type VendorContactView,
} from "@/workflows/vendorContacts";
import { ROLE_LABEL } from "@/features/vendors/contactLabels";
import { SuppressionBadge } from "@/features/vendors/VendorContactsPanel";

/**
 * The contractor-facing deficiency and exception workflow, mounted on vendor
 * detail (all of a vendor's cases) and on each project assignment (that
 * assignment's cases). Reads are live-mode only - the demo repository has no
 * compliance-case data to show, and the honest thing there is to not pretend.
 *
 * Everything written here goes through the schema's own RPCs: the correction
 * clock via request_deficiency_correction(), the email via the suppression-
 * safe sendRequest() path with purpose "correction", the waiver via
 * approve_compliance_exception() (owner/risk_manager only - the form is
 * hidden for other roles and the RPC rejects them regardless). There is
 * deliberately no "mark compliant" control anywhere in this file; a
 * deficiency leaves "open" only through new evidence or an approved
 * exception, both recorded by the database itself.
 */

const button =
  "focusable rounded-sm border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-60";
const primary =
  "focusable rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60";
const inputClass = "focusable rounded-sm border border-input bg-background px-2 py-1.5 text-xs";

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

function statusTone(status: DeficiencyView["status"]): string {
  switch (status) {
    case "open":
      return "text-destructive";
    case "resolved":
      return "text-ok";
    case "waived":
      return "text-foreground";
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Active = the waiver the deficiency currently points at; expired = past its expiry, not yet reopened. */
function activeException(deficiency: DeficiencyView) {
  const byId = deficiency.exceptions.find(
    (e) =>
      e.id ===
      (deficiency as DeficiencyView & { waived_via_exception_id?: string }).waived_via_exception_id,
  );
  if (byId) return byId;
  return deficiency.exceptions[0] ?? null;
}

function exceptionState(
  exception: NonNullable<ReturnType<typeof activeException>>,
): "active" | "expired-awaiting-reopen" | "reopened" {
  const todayIso = today();
  if (exception.reopenedAt) return "reopened";
  if (exception.expiresOn < todayIso) return "expired-awaiting-reopen";
  return "active";
}

const EXCEPTION_STATE_LABELS = {
  active: "Active waiver",
  "expired-awaiting-reopen": "Expired — deficiency reopens on the next sweep",
  reopened: "Expired — deficiency reopened",
} as const;

// ---------------------------------------------------------------------------
// Escalation summary
// ---------------------------------------------------------------------------

function EscalationSummary({ deficiency }: { deficiency: DeficiencyView }) {
  const waiting =
    deficiency.correctionRequestedAt !== null &&
    (deficiency.latestEvaluation === null ||
      deficiency.latestEvaluation.evaluatedAt <= deficiency.correctionRequestedAt);
  const daysWaiting = waiting
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(deficiency.correctionRequestedAt!).getTime()) / 86_400_000,
        ),
      )
    : null;

  return (
    <ul
      className="mt-2 space-y-0.5 text-[11px] text-muted-foreground"
      data-testid="escalation-summary"
    >
      <li>
        Correction requested:{" "}
        {deficiency.correctionRequestedAt
          ? day(deficiency.correctionRequestedAt)
          : "not yet requested"}
      </li>
      {waiting ? (
        <li>
          Waiting for resubmission — {daysWaiting} day{daysWaiting === 1 ? "" : "s"} elapsed
        </li>
      ) : null}
      <li>Escalation: {escalationLabel(deficiency.escalationLevel)}</li>
      <li>Last escalation: {deficiency.lastEscalatedAt ? day(deficiency.lastEscalatedAt) : "—"}</li>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Exception history + approval form
// ---------------------------------------------------------------------------

function ExceptionHistory({ deficiency }: { deficiency: DeficiencyView }) {
  const profiles = useQuery({
    queryKey: [
      "exception-approver-names",
      deficiency.exceptions.map((e) => e.approvedBy).join(","),
    ],
    enabled: deficiency.exceptions.length > 0,
    queryFn: async () => {
      const ids = [...new Set(deficiency.exceptions.map((e) => e.approvedBy))];
      const result = await getSupabaseClient()
        .from("profiles")
        .select("id, full_name")
        .in("id", ids);
      if (result.error) throw new Error(result.error.message);
      return Object.fromEntries(
        (result.data ?? []).map((p: { id: string; full_name: string | null }) => [
          p.id,
          p.full_name,
        ]),
      ) as Record<string, string | null>;
    },
  });

  if (deficiency.exceptions.length === 0) return null;

  return (
    <div className="mt-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Exceptions on this deficiency
      </p>
      <ul className="mt-1 space-y-1.5">
        {deficiency.exceptions.map((exception) => (
          <li
            key={exception.id}
            className="rounded-sm border border-border p-2 text-xs"
            data-testid="exception-row"
          >
            <p className="font-semibold">
              {EXCEPTION_STATE_LABELS[exceptionState(exception)]}
              <span className="ml-1 font-normal text-muted-foreground">
                approved {new Date(exception.approvedAt).toLocaleString()} by{" "}
                {profiles.data?.[exception.approvedBy] ?? "an authorized approver"}
              </span>
            </p>
            <p className="mt-1">
              <span className="text-muted-foreground">Reason:</span> {exception.reason}
            </p>
            <p className="mt-0.5">
              <span className="text-muted-foreground">
                Effective {day(exception.effectiveOn)} through {day(exception.expiresOn)} ·
                {exception.vendorVisible ? " visible to the vendor" : " internal only"} · remaining
                risk acknowledged
              </span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExceptionForm({ deficiency, onDone }: { deficiency: DeficiencyView; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [effectiveOn, setEffectiveOn] = useState(today());
  const [expiresOn, setExpiresOn] = useState("");
  const [vendorVisible, setVendorVisible] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [supportingDocumentId, setSupportingDocumentId] = useState("");

  const evidence = useQuery({
    queryKey: ["deficiency-evidence-documents", deficiency.evidenceDocumentIds.join(",")],
    enabled: deficiency.evidenceDocumentIds.length > 0,
    queryFn: async () => {
      const result = await getSupabaseClient()
        .from("vendor_documents")
        .select("id, document_type, file_name")
        .in("id", deficiency.evidenceDocumentIds);
      if (result.error) throw new Error(result.error.message);
      return result.data as Array<{ id: string; document_type: string; file_name: string | null }>;
    },
  });

  const approve = useMutation({
    mutationFn: () =>
      approveException({
        data: {
          deficiencyId: deficiency.id,
          reason,
          effectiveOn,
          expiresOn,
          vendorVisible,
          remainingRiskAcknowledged: acknowledged,
          ...(supportingDocumentId ? { supportingDocumentId } : {}),
        },
      }),
    onSuccess: onDone,
  });

  const canSubmit =
    reason.trim().length > 0 && expiresOn !== "" && expiresOn > effectiveOn && acknowledged;

  return (
    <form
      aria-label="Approve exception"
      className="mt-3 space-y-3 rounded-sm border border-border bg-muted p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !approve.isPending) approve.mutate();
      }}
    >
      <p className="font-semibold">Approve an exception for {requirementHeadline(deficiency)}</p>
      <label className="block font-medium">
        Reason
        <textarea
          required
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why this deficiency is acceptable for a limited time"
          className={`focusable mt-1 block w-full ${inputClass}`}
        />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block font-medium">
          Effective date
          <input
            type="date"
            required
            value={effectiveOn}
            onChange={(event) => setEffectiveOn(event.target.value)}
            className={`focusable mt-1 block w-full ${inputClass}`}
          />
        </label>
        <label className="block font-medium">
          Expiration date
          <input
            type="date"
            required
            value={expiresOn}
            onChange={(event) => setExpiresOn(event.target.value)}
            className={`focusable mt-1 block w-full ${inputClass}`}
          />
        </label>
      </div>
      <label className="block font-medium">
        Supporting document (optional)
        <select
          value={supportingDocumentId}
          onChange={(event) => setSupportingDocumentId(event.target.value)}
          className={`focusable mt-1 block w-full ${inputClass}`}
        >
          <option value="">None</option>
          {(evidence.data ?? []).map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.file_name ?? doc.document_type}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-2 font-medium">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={vendorVisible}
          onChange={(event) => setVendorVisible(event.target.checked)}
        />
        Show this waiver to the vendor
      </label>
      <label
        className="flex items-start gap-2 rounded-sm border border-border bg-background p-2 font-medium"
        data-testid="risk-acknowledgement"
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>
          I acknowledge that this requirement stays unmet while the waiver is active and that the
          remaining risk is accepted.
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!canSubmit || approve.isPending} className={primary}>
          {approve.isPending ? "Approving…" : "Approve exception"}
        </button>
        <button type="button" className={button} onClick={onDone}>
          Cancel
        </button>
      </div>
      {approve.isError ? (
        <p role="alert" className="font-semibold text-destructive">
          {approve.error instanceof Error
            ? approve.error.message
            : "Could not approve the exception."}
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Correction request composer
// ---------------------------------------------------------------------------

interface Recipient {
  contactId: string;
  name: string;
  email: string;
  roles: string[];
  suppression: VendorContactView["suppression"];
}

function CorrectionComposer({
  vendorId,
  selected,
  onClose,
}: {
  vendorId: string;
  selected: DeficiencyView[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [chosenContacts, setChosenContacts] = useState<string[]>([]);
  const [sentTo, setSentTo] = useState<string[] | null>(null);

  const contacts = useQuery({
    queryKey: ["correction-recipients", vendorId],
    queryFn: () => getVendorContactsPanel({ data: { vendorId } }),
  });

  const recipients: Recipient[] = useMemo(() => {
    const byId = new Map<string, Recipient>();
    for (const link of contacts.data?.contacts ?? []) {
      const existing = byId.get(link.contactId);
      if (existing) existing.roles.push(link.role);
      else
        byId.set(link.contactId, {
          contactId: link.contactId,
          name: link.name,
          email: link.email,
          roles: [link.role],
          suppression: link.suppression,
        });
    }
    return [...byId.values()];
  }, [contacts.data]);

  const eligible = recipients.filter((r) => !r.suppression);
  const chosen = eligible.filter((r) => chosenContacts.includes(r.contactId));

  const send = useMutation({
    mutationFn: async () => {
      // Two deliberate steps, in this order: the suppression-safe multi-
      // recipient email (sendRequest re-derives the recipient list server-
      // side and excludes suppressed addresses), then the correction clock
      // (request_deficiency_correction) once the request actually went out.
      const { sendRequest } = await import("@/workflows/communications");
      const result = await sendRequest({
        data: {
          vendorId,
          purpose: "correction",
          confirmedRecipientIds: chosen.map((r) => r.contactId),
        },
      });
      await requestCorrection({ data: { deficiencyIds: selected.map((d) => d.id) } });
      return result;
    },
    onSuccess: async (_data, _vars) => {
      setSentTo(chosen.map((r) => r.name));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["communication-history", vendorId] }),
        queryClient.invalidateQueries({ queryKey: ["vendor-compliance", vendorId] }),
      ]);
    },
  });

  if (sentTo) {
    return (
      <div role="status" className="mt-3 rounded-sm border border-border bg-muted p-3 text-xs">
        <p className="font-semibold">
          Correction request sent to {sentTo.length} recipient{sentTo.length === 1 ? "" : "s"}. The
          3/7/14-day escalation clock has started on the selected deficiencies.
        </p>
        <button type="button" className={`${button} mt-2`} onClick={onClose}>
          Done
        </button>
      </div>
    );
  }

  return (
    <form
      aria-label="Request correction"
      className="mt-3 space-y-3 rounded-sm border border-border bg-muted p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length > 0 && !send.isPending) send.mutate();
      }}
    >
      <p className="font-semibold">
        Request correction for {selected.length} item{selected.length === 1 ? "" : "s"}
      </p>
      <div className="rounded-sm border border-border bg-background p-2">
        <p className="font-semibold">What the vendor will be asked to fix:</p>
        <ul className="mt-1 space-y-0.5" data-testid="correction-instructions-preview">
          {selected.map((deficiency) => (
            <li key={deficiency.id}>
              {requirementHeadline(deficiency)} — {generateCorrectionInstruction(deficiency)}
            </li>
          ))}
        </ul>
      </div>
      <fieldset>
        <legend className="font-medium">Recipients</legend>
        {contacts.isLoading ? (
          <p className="mt-1 text-muted-foreground">Loading contacts…</p>
        ) : eligible.length === 0 ? (
          <p className="mt-1 text-muted-foreground">
            This vendor has no eligible contacts. Add one in Contacts first.
          </p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {recipients.map((r) => (
              <li key={r.contactId}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={Boolean(r.suppression)}
                    checked={!r.suppression && chosenContacts.includes(r.contactId)}
                    onChange={() =>
                      setChosenContacts(
                        chosenContacts.includes(r.contactId)
                          ? chosenContacts.filter((id) => id !== r.contactId)
                          : [...chosenContacts, r.contactId],
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">{r.name}</span>{" "}
                    <span className="text-muted-foreground">
                      {r.roles
                        .map((role) => ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role)
                        .join(" · ")}
                    </span>
                    <span className="block break-all">{r.email}</span>
                    {r.suppression ? (
                      <span className="mt-0.5 inline-flex items-center gap-1.5 text-destructive">
                        <SuppressionBadge reason={r.suppression} /> Cannot be selected
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={chosen.length === 0 || send.isPending} className={primary}>
          {send.isPending
            ? "Sending…"
            : `Send to ${chosen.length} recipient${chosen.length === 1 ? "" : "s"}`}
        </button>
        <button type="button" className={button} onClick={onClose}>
          Cancel
        </button>
      </div>
      {send.isError ? (
        <p role="alert" className="font-semibold text-destructive">
          {send.error instanceof Error
            ? send.error.message
            : "Could not send the correction request."}
        </p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Deficiency row + detail
// ---------------------------------------------------------------------------

function DeficiencyRow({
  vendorId,
  deficiency,
  canWrite,
  canApprove,
}: {
  vendorId: string;
  deficiency: DeficiencyView;
  canWrite: boolean;
  canApprove: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [filingException, setFilingException] = useState(false);
  const values = requiredVsSubmitted(deficiency);
  const history = useQuery({
    queryKey: ["communication-history", vendorId],
    enabled: open,
    queryFn: () => getCommunicationHistory({ data: { vendorId } }),
  });
  const correctionRequests = (history.data ?? []).filter(
    (row) => row.requestPurpose === "correction",
  );

  return (
    <li
      className="rounded-sm border border-border p-3"
      data-testid="deficiency-row"
      data-status={deficiency.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{requirementHeadline(deficiency)}</p>
          <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Required</dt>
            <dd className="numeric font-mono">{values.required}</dd>
            <dt className="text-muted-foreground">Submitted</dt>
            <dd
              className={`numeric font-mono ${deficiency.status === "open" ? "text-destructive" : ""}`}
            >
              {values.submitted}
            </dd>
          </dl>
        </div>
        <div className="text-right">
          <p className={`text-xs font-semibold ${statusTone(deficiency.status)}`}>
            {DEFICIENCY_STATUS_LABELS[deficiency.status]}
          </p>
          {deficiency.status === "waived" && activeException(deficiency) ? (
            <p className="text-[11px] text-muted-foreground" data-testid="exception-state">
              {EXCEPTION_STATE_LABELS[exceptionState(activeException(deficiency)!)]}
            </p>
          ) : null}
        </div>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        First detected {day(deficiency.firstDetectedAt)} · Latest evaluation{" "}
        {deficiency.latestEvaluation ? day(deficiency.latestEvaluation.evaluatedAt) : "—"}
        {deficiency.resolvedAt ? ` · Resolved ${day(deficiency.resolvedAt)}` : ""}
      </p>
      {deficiency.status === "open" ? <EscalationSummary deficiency={deficiency} /> : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          className={button}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide detail" : "View detail"}
        </button>
        {canWrite && deficiency.status === "open" ? (
          <button type="button" className={button} onClick={() => setComposing(!composing)}>
            Request correction
          </button>
        ) : null}
        {canApprove && deficiency.status === "open" ? (
          <button
            type="button"
            className={button}
            onClick={() => setFilingException(!filingException)}
          >
            File exception
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          className="mt-3 space-y-2 border-t border-border pt-2 text-xs"
          data-testid="deficiency-detail"
        >
          <p>
            <span className="text-muted-foreground">What was found: </span>
            {deficiency.explanation || "No explanation was recorded."}
          </p>
          <p>
            <span className="text-muted-foreground">How to fix it: </span>
            {generateCorrectionInstruction(deficiency)}
          </p>
          <div>
            <p className="font-semibold">Evaluation history</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              <li>
                Opened {day(deficiency.firstDetectedAt)} — status now{" "}
                {DEFICIENCY_STATUS_LABELS[deficiency.status].toLowerCase()}
              </li>
              {deficiency.latestEvaluation ? (
                <li>Latest evaluation {day(deficiency.latestEvaluation.evaluatedAt)}</li>
              ) : null}
            </ul>
          </div>
          <div>
            <p className="font-semibold">Correction emails</p>
            {history.isLoading ? (
              <p className="mt-1 text-muted-foreground">Loading history…</p>
            ) : correctionRequests.length === 0 ? (
              <p className="mt-1 text-muted-foreground">No correction request has been sent yet.</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {correctionRequests.slice(0, 5).map((row) => (
                  <li key={row.outboxId}>
                    {new Date(row.createdAt).toLocaleDateString()} · {row.recipientEmail} ·{" "}
                    {row.sent ? "sent" : row.suppressed ? "excluded — suppressed" : row.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <ExceptionHistory deficiency={deficiency} />
        </div>
      ) : null}

      {composing ? (
        <CorrectionComposer
          vendorId={vendorId}
          selected={[deficiency]}
          onClose={() => setComposing(false)}
        />
      ) : null}
      {filingException ? (
        <ExceptionForm deficiency={deficiency} onDone={() => setFilingException(false)} />
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function ComplianceCasesSection({
  vendorId,
  assignmentId,
  canWrite,
  canApprove,
}: {
  vendorId: string;
  /** When set, only that assignment's cases are shown (project detail view). */
  assignmentId?: string | undefined;
  canWrite: boolean;
  canApprove: boolean;
}) {
  const cases = useQuery({
    queryKey: ["vendor-compliance", vendorId, assignmentId ?? "all"],
    queryFn: () =>
      assignmentId
        ? getAssignmentCompliance({ data: { assignmentId } })
        : getVendorCompliance({ data: { vendorId } }),
  });

  if (cases.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading compliance cases…</p>;
  }
  if (cases.isError) {
    return (
      <p role="alert" className="text-sm font-semibold text-destructive">
        Compliance cases could not be loaded.
      </p>
    );
  }

  const all = cases.data ?? [];
  const openCount = all.reduce(
    (sum, c) => sum + c.deficiencies.filter((d) => d.status === "open").length,
    0,
  );

  if (all.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="no-cases">
        No compliance cases yet. Cases appear here when a document submission is evaluated and
        something does not meet the requirements.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground" data-testid="case-count">
        {all.length} case{all.length === 1 ? "" : "s"} · {openCount} open deficienc
        {openCount === 1 ? "y" : "ies"}
      </p>
      {all.map((c) => (
        <CaseBlock
          key={c.caseId}
          caseView={c}
          vendorId={vendorId}
          canWrite={canWrite}
          canApprove={canApprove}
        />
      ))}
    </div>
  );
}

function CaseBlock({
  caseView,
  vendorId,
  canWrite,
  canApprove,
}: {
  caseView: ComplianceCaseView;
  vendorId: string;
  canWrite: boolean;
  canApprove: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkComposing, setBulkComposing] = useState(false);
  const openDeficiencies = caseView.deficiencies.filter((d) => d.status === "open");
  const selectedViews = openDeficiencies.filter((d) => selected.includes(d.id));

  return (
    <section className="rounded-md border border-border bg-card" aria-label="Compliance case">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
        <p>
          <span className="font-semibold">{caseView.projectName}</span>
          <span className="text-muted-foreground"> · case opened {day(caseView.openedAt)}</span>
        </p>
        {canWrite && openDeficiencies.length > 1 ? (
          <button
            type="button"
            className={button}
            disabled={selected.length === 0}
            onClick={() => setBulkComposing(true)}
          >
            Request correction ({selected.length} selected)
          </button>
        ) : null}
      </div>
      {caseView.deficiencies.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          The latest evaluation found no problems on this case.
        </p>
      ) : (
        <ul className="space-y-3 p-3">
          {caseView.deficiencies.map((deficiency) => (
            <DeficiencyRow
              key={deficiency.id}
              vendorId={vendorId}
              deficiency={deficiency}
              canWrite={canWrite}
              canApprove={canApprove}
            />
          ))}
        </ul>
      )}
      {bulkComposing ? (
        <div className="px-3 pb-3">
          <BulkComposer
            vendorId={vendorId}
            selected={selectedViews}
            clearSelection={() => setSelected([])}
            onClose={() => setBulkComposing(false)}
          />
        </div>
      ) : null}
    </section>
  );
}

/** Bulk composer over a case's checked deficiencies - same flow as the single one. */
function BulkComposer({
  vendorId,
  selected,
  clearSelection,
  onClose,
}: {
  vendorId: string;
  selected: DeficiencyView[];
  clearSelection: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [chosenContacts, setChosenContacts] = useState<string[]>([]);

  const contacts = useQuery({
    queryKey: ["correction-recipients", vendorId],
    queryFn: () => getVendorContactsPanel({ data: { vendorId } }),
  });

  const recipients = useMemo(() => {
    const byId = new Map<string, Recipient>();
    for (const link of contacts.data?.contacts ?? []) {
      const existing = byId.get(link.contactId);
      if (existing) existing.roles.push(link.role);
      else
        byId.set(link.contactId, {
          contactId: link.contactId,
          name: link.name,
          email: link.email,
          roles: [link.role],
          suppression: link.suppression,
        });
    }
    return [...byId.values()];
  }, [contacts.data]);

  const eligible = recipients.filter((r) => !r.suppression);
  const chosen = eligible.filter((r) => chosenContacts.includes(r.contactId));

  const send = useMutation({
    mutationFn: async () => {
      const { sendRequest } = await import("@/workflows/communications");
      const result = await sendRequest({
        data: {
          vendorId,
          purpose: "correction",
          confirmedRecipientIds: chosen.map((r) => r.contactId),
        },
      });
      await requestCorrection({ data: { deficiencyIds: selected.map((d) => d.id) } });
      return result;
    },
    onSuccess: async () => {
      clearSelection();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["communication-history", vendorId] }),
        queryClient.invalidateQueries({ queryKey: ["vendor-compliance", vendorId] }),
      ]);
      onClose();
    },
  });

  return (
    <form
      aria-label="Request correction for selected deficiencies"
      className="space-y-3 rounded-sm border border-border bg-muted p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen.length > 0 && !send.isPending) send.mutate();
      }}
    >
      <div className="rounded-sm border border-border bg-background p-2">
        <p className="font-semibold">What the vendor will be asked to fix:</p>
        <ul className="mt-1 space-y-0.5" data-testid="correction-instructions-preview">
          {selected.map((deficiency) => (
            <li key={deficiency.id}>
              {requirementHeadline(deficiency)} — {generateCorrectionInstruction(deficiency)}
            </li>
          ))}
        </ul>
      </div>
      <fieldset>
        <legend className="font-medium">Recipients</legend>
        <ul className="mt-1 space-y-1.5">
          {recipients.map((r) => (
            <li key={r.contactId}>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={Boolean(r.suppression)}
                  checked={!r.suppression && chosenContacts.includes(r.contactId)}
                  onChange={() =>
                    setChosenContacts(
                      chosenContacts.includes(r.contactId)
                        ? chosenContacts.filter((id) => id !== r.contactId)
                        : [...chosenContacts, r.contactId],
                    )
                  }
                />
                <span>
                  <span className="font-medium">{r.name}</span>{" "}
                  <span className="break-all">{r.email}</span>
                  {r.suppression ? (
                    <span className="mt-0.5 inline-flex items-center gap-1.5 text-destructive">
                      <SuppressionBadge reason={r.suppression} /> Cannot be selected
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={chosen.length === 0 || send.isPending} className={primary}>
          {send.isPending
            ? "Sending…"
            : `Send to ${chosen.length} recipient${chosen.length === 1 ? "" : "s"}`}
        </button>
        <button type="button" className={button} onClick={onClose}>
          Cancel
        </button>
      </div>
      {send.isError ? (
        <p role="alert" className="font-semibold text-destructive">
          {send.error instanceof Error
            ? send.error.message
            : "Could not send the correction request."}
        </p>
      ) : null}
    </form>
  );
}
