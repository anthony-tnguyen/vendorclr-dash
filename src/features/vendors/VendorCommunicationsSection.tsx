import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { VendorContactRole } from "@/data/dbTypeAliases";
import {
  REQUEST_PURPOSES,
  sendRequest,
  type RequestPurpose,
  type SendRequestResult,
} from "@/workflows/communications";
import { canCancelRequest } from "@/workflows/uploadTokens";
import { cancelUploadRequest } from "@/workflows/vendorUploadRequests";
import {
  getCommunicationHistory,
  getVendorContactsPanel,
  type CommunicationHistoryRow,
  type VendorContactView,
} from "@/workflows/vendorContacts";

import {
  PURPOSE_LABEL,
  ROLE_LABEL,
  SUPPRESSION_LABEL,
  vendorContactsQueryKey,
} from "./contactLabels";
import { SuppressionBadge } from "./VendorContactsPanel";

/**
 * Document requests + communication history for one vendor.
 *
 * The composer always shows, before anything is sent, exactly who will
 * receive the request and who is excluded. Suppressed contacts cannot be
 * ticked; the server (prepare_contact_request) re-derives the list and
 * excludes them again regardless of what this screen sends.
 *
 * Resend opens the same composer pre-filled with that request's recipients,
 * editable, and sends a brand-new request (new token); the old link is
 * cancelled server-side.
 */

const button =
  "focusable rounded-sm border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-60";
const primary =
  "focusable rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60";

interface Draft {
  purpose: RequestPurpose;
  selected: string[];
  resendOfRequestId: string | null;
}

interface Recipient {
  contactId: string;
  name: string;
  email: string;
  organization: string;
  roles: VendorContactRole[];
  suppression: VendorContactView["suppression"];
}

const ROLE_RANK: Record<VendorContactRole, number> = { operational: 0, broker: 1, secondary: 2 };

/** One entry per contact - a contact linked under two roles is still one recipient. */
function toRecipients(contacts: VendorContactView[]): Recipient[] {
  const byId = new Map<string, Recipient>();
  for (const c of contacts) {
    const existing = byId.get(c.contactId);
    if (existing) {
      existing.roles.push(c.role);
      existing.roles.sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
    } else {
      byId.set(c.contactId, {
        contactId: c.contactId,
        name: c.name,
        email: c.email,
        organization: c.organization,
        roles: [c.role],
        suppression: c.suppression,
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) => ROLE_RANK[a.roles[0]!] - ROLE_RANK[b.roles[0]!] || a.name.localeCompare(b.name),
  );
}

function outcomeLabel(outcome: SendRequestResult["recipients"][number]["outcome"]): string {
  switch (outcome) {
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    case "not_configured":
      return "Not emailed — email delivery is not configured; share the link";
    case "skipped_suppressed":
      return "Excluded — suppressed";
  }
}

function RequestComposer({
  vendorId,
  recipients,
  draft,
  setDraft,
  onClose,
}: {
  vendorId: string;
  recipients: Recipient[];
  draft: Draft;
  setDraft: (draft: Draft) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<SendRequestResult | null>(null);
  const [copied, setCopied] = useState(false);

  const eligible = recipients.filter((r) => !r.suppression);
  const suppressed = recipients.filter((r) => r.suppression);
  const chosen = eligible.filter((r) => draft.selected.includes(r.contactId));

  const send = useMutation({
    mutationFn: () =>
      sendRequest({
        data: {
          vendorId,
          purpose: draft.purpose,
          confirmedRecipientIds: chosen.map((r) => r.contactId),
          ...(draft.resendOfRequestId ? { resendOfRequestId: draft.resendOfRequestId } : {}),
        },
      }),
    onSuccess: async (data) => {
      setResult(data);
      setCopied(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["communication-history", vendorId] }),
        queryClient.invalidateQueries({ queryKey: vendorContactsQueryKey(vendorId) }),
      ]);
    },
  });

  const toggle = (contactId: string) =>
    setDraft({
      ...draft,
      selected: draft.selected.includes(contactId)
        ? draft.selected.filter((id) => id !== contactId)
        : [...draft.selected, contactId],
    });

  if (result) {
    return (
      <div
        className="mt-3 space-y-2 rounded-sm border border-border bg-muted p-3 text-xs"
        role="status"
      >
        <p className="font-semibold">Request created.</p>
        <ul className="space-y-1">
          {result.recipients.map((r) => (
            <li key={r.contactId}>
              {r.name} &lt;{r.email}&gt; ({ROLE_LABEL[r.role as VendorContactRole] ?? r.role}):{" "}
              <span
                className={
                  r.outcome === "sent" ? "font-semibold" : "font-semibold text-destructive"
                }
              >
                {outcomeLabel(r.outcome)}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={result.uploadUrl}
            aria-label="Vendor upload link"
            onFocus={(e) => e.currentTarget.select()}
            className="focusable min-w-0 flex-1 rounded-sm border border-input bg-background px-2 py-1.5 font-mono text-[11px]"
          />
          <button
            type="button"
            className={button}
            onClick={() => {
              void navigator.clipboard?.writeText(result.uploadUrl).then(
                () => setCopied(true),
                () => undefined,
              );
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <button type="button" className={button} onClick={onClose}>
          Done
        </button>
      </div>
    );
  }

  return (
    <form
      aria-label={draft.resendOfRequestId ? "Resend document request" : "Request documents"}
      className="mt-3 space-y-3 rounded-sm border border-border bg-muted p-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen.length > 0) send.mutate();
      }}
    >
      {draft.resendOfRequestId ? (
        <p className="text-muted-foreground">
          Resending creates a new upload link. The previous link stops working if the vendor has not
          used it yet.
        </p>
      ) : null}
      <label className="block font-medium" htmlFor="request-purpose">
        Request type
        <select
          id="request-purpose"
          value={draft.purpose}
          onChange={(e) => setDraft({ ...draft, purpose: e.target.value as RequestPurpose })}
          className="focusable mt-1 block rounded-sm border border-input bg-background px-2 py-1.5"
        >
          {REQUEST_PURPOSES.map((p) => (
            <option key={p} value={p}>
              {PURPOSE_LABEL[p]}
            </option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend className="font-medium">Recipients</legend>
        {recipients.length === 0 ? (
          <p className="mt-1 text-muted-foreground">
            This vendor has no contacts. Add one in Contacts first.
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
                    checked={!r.suppression && draft.selected.includes(r.contactId)}
                    onChange={() => toggle(r.contactId)}
                  />
                  <span>
                    <span className="font-medium">{r.name}</span>{" "}
                    <span className="text-muted-foreground">
                      {r.roles.map((role) => ROLE_LABEL[role]).join(" · ")}
                      {r.organization ? ` · ${r.organization}` : ""}
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

      <div className="rounded-sm border border-border bg-background p-2" aria-live="polite">
        <p className="font-semibold">Will be emailed to ({chosen.length}):</p>
        {chosen.length === 0 ? (
          <p className="text-muted-foreground">Nobody yet — select at least one recipient.</p>
        ) : (
          <ul data-testid="request-recipient-preview">
            {chosen.map((r) => (
              <li key={r.contactId}>
                {r.name} &lt;{r.email}&gt; — {ROLE_LABEL[r.roles[0]!]}
              </li>
            ))}
          </ul>
        )}
        {suppressed.length > 0 ? (
          <>
            <p className="mt-2 font-semibold text-destructive">Excluded ({suppressed.length}):</p>
            <ul data-testid="request-excluded-preview">
              {suppressed.map((r) => (
                <li key={r.contactId} className="text-destructive">
                  {r.name} &lt;{r.email}&gt; — {SUPPRESSION_LABEL[r.suppression!.reason]}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={send.isPending || chosen.length === 0} className={primary}>
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
          {send.error instanceof Error ? send.error.message : "Could not send the request."}
        </p>
      ) : null}
    </form>
  );
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        on ? "bg-foreground/10 text-foreground" : "text-muted-foreground/60 line-through"
      }`}
      aria-label={`${label}: ${on ? "yes" : "no"}`}
    >
      {label}
    </span>
  );
}

interface RequestGroup {
  key: string;
  requestId: string | null;
  createdAt: string;
  purpose: string | null;
  template: string;
  requestStatus: string | null;
  uploadReceived: boolean;
  canResend: boolean;
  rows: CommunicationHistoryRow[];
}

function groupHistory(rows: CommunicationHistoryRow[]): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const row of rows) {
    const key = row.requestId ?? row.outboxId;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
      if (row.createdAt < group.createdAt) group.createdAt = row.createdAt;
    } else {
      groups.set(key, {
        key,
        requestId: row.requestId,
        createdAt: row.createdAt,
        purpose: row.requestPurpose,
        template: row.template,
        requestStatus: row.requestStatus,
        uploadReceived: row.uploadReceived,
        canResend: row.canResend,
        rows: [row],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function describeTemplate(group: RequestGroup): string {
  if (group.purpose) return `${PURPOSE_LABEL[group.purpose] ?? group.purpose} request`;
  return group.template.replace(/_/g, " ");
}

function CommunicationHistory({
  vendorId,
  canWrite,
  onResend,
}: {
  vendorId: string;
  canWrite: boolean;
  onResend: (group: RequestGroup) => void;
}) {
  const queryClient = useQueryClient();
  const history = useQuery({
    queryKey: ["communication-history", vendorId],
    queryFn: () => getCommunicationHistory({ data: { vendorId } }),
  });
  const cancel = useMutation({
    mutationFn: (requestId: string) => cancelUploadRequest({ data: { requestId } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["communication-history", vendorId] }),
  });

  const groups = useMemo(() => groupHistory(history.data ?? []), [history.data]);

  if (history.isLoading) {
    return <p className="mt-3 text-xs text-muted-foreground">Loading communication history…</p>;
  }
  if (history.isError) {
    return (
      <p role="alert" className="mt-3 text-xs font-semibold text-destructive">
        Communication history could not be loaded.
      </p>
    );
  }
  if (groups.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        Nothing has been sent to this vendor yet.
      </p>
    );
  }

  return (
    <ol className="mt-3 space-y-3" aria-label="Communication history">
      {groups.map((group) => (
        <li
          key={group.key}
          className="rounded-sm border border-border p-3"
          data-testid="communication-entry"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p>
              <span className="font-semibold capitalize">{describeTemplate(group)}</span>
              <span className="text-muted-foreground">
                {" "}
                · {new Date(group.createdAt).toLocaleString()}
                {group.requestStatus ? ` · ${group.requestStatus.replace(/_/g, " ")}` : ""}
              </span>
            </p>
            <div className="flex items-center gap-1.5">
              {group.requestId ? <Flag on={group.uploadReceived} label="Upload received" /> : null}
              {canWrite &&
              group.requestId &&
              group.requestStatus &&
              canCancelRequest(group.requestStatus) ? (
                <button
                  type="button"
                  className={button}
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(group.requestId!)}
                >
                  Cancel link
                </button>
              ) : null}
              {canWrite && group.canResend ? (
                <button type="button" className={button} onClick={() => onResend(group)}>
                  Resend
                </button>
              ) : null}
            </div>
          </div>
          <table className="mt-2 w-full text-left text-xs">
            <caption className="sr-only">Recipients of this message</caption>
            <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 font-medium">
                  Recipient
                </th>
                <th scope="col" className="py-1 font-medium">
                  Role
                </th>
                <th scope="col" className="py-1 font-medium">
                  Delivery
                </th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.outboxId} className="border-t border-border align-top">
                  <td className="py-1.5 pr-2">
                    {row.recipientName ? (
                      <span className="block font-medium">{row.recipientName}</span>
                    ) : null}
                    <span className="break-all">{row.recipientEmail}</span>
                  </td>
                  <td className="py-1.5 pr-2">{row.role ? ROLE_LABEL[row.role] : "—"}</td>
                  <td className="py-1.5">
                    {row.suppressed ? (
                      <span className="font-semibold text-destructive">Excluded — suppressed</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        <Flag on={row.sent} label="Sent" />
                        <Flag on={row.delivered} label="Delivered" />
                        <Flag on={row.bounced} label="Bounced" />
                        <Flag on={row.complained} label="Complained" />
                        <Flag on={row.failed} label="Failed" />
                      </span>
                    )}
                    {row.error && !row.suppressed ? (
                      <span className="mt-1 block text-[11px] text-destructive">{row.error}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
      ))}
      {cancel.isError ? (
        <li role="alert" className="text-xs font-semibold text-destructive">
          {cancel.error instanceof Error ? cancel.error.message : "Could not cancel the request."}
        </li>
      ) : null}
    </ol>
  );
}

export function VendorCommunicationsSection({
  vendorId,
  canWrite,
}: {
  vendorId: string;
  canWrite: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const panel = useQuery({
    queryKey: vendorContactsQueryKey(vendorId),
    queryFn: () => getVendorContactsPanel({ data: { vendorId } }),
  });
  const recipients = useMemo(() => toRecipients(panel.data?.contacts ?? []), [panel.data]);

  const openFresh = () =>
    setDraft({
      purpose: "renewal",
      resendOfRequestId: null,
      selected: recipients
        .filter((r) => !r.suppression && r.roles.includes("operational"))
        .map((r) => r.contactId),
    });

  const openResend = (group: RequestGroup) => {
    const previous = new Set(group.rows.map((r) => r.contactId).filter(Boolean));
    setDraft({
      purpose: (REQUEST_PURPOSES as readonly string[]).includes(group.purpose ?? "")
        ? (group.purpose as RequestPurpose)
        : "renewal",
      resendOfRequestId: group.requestId,
      selected: recipients
        .filter((r) => !r.suppression && previous.has(r.contactId))
        .map((r) => r.contactId),
    });
  };

  return (
    <section
      aria-labelledby="communications-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="communications-heading" className="text-sm font-semibold text-foreground">
          Document requests &amp; communication history
        </h2>
        {canWrite && !draft ? (
          <button type="button" className={primary} onClick={openFresh}>
            Request documents
          </button>
        ) : null}
      </div>
      {draft ? (
        <RequestComposer
          vendorId={vendorId}
          recipients={recipients}
          draft={draft}
          setDraft={setDraft}
          onClose={() => setDraft(null)}
        />
      ) : null}
      <CommunicationHistory vendorId={vendorId} canWrite={canWrite} onResend={openResend} />
    </section>
  );
}
