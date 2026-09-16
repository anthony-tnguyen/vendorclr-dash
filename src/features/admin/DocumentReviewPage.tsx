import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  getReviewQueueItem,
  resolveReviewItem,
  selectClassifiedPolicies,
  type ReviewQueueItemDetail,
} from "@/workflows/documentReview";
import { reprocessDocument } from "@/workflows/vendorUploadRequests";
import type { PolicyType } from "@/workflows/insuranceExtractionSchema";

/**
 * The screen "What is still not built" in supabase/README.md used to flag as
 * missing: looking at parsed_data/review_reason for a needs_review or failed
 * document, and approving or rejecting it by hand. Staff-only (AdminGuard),
 * matching the queue list it's opened from - see assertPlatformAdmin() in
 * vendorUploadRequests.ts for the server-side half of that boundary; this
 * component's AdminGuard is presentation only, the same as everywhere else
 * in this app.
 */

function formatPolicyType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatBool(value: boolean | null): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Not confirmed";
}

/**
 * Same loose, trimmed/case-insensitive comparison as VendorDetailPage.tsx's
 * copy - a first-pass signal for a reviewer to look twice at, never a hard
 * gate; the raw extracted text is always shown regardless. Duplicated
 * rather than shared for a 2-line helper - if the comparison rule ever gets
 * more sophisticated, check both copies.
 */
function looksLikeMismatch(certificateHolderName: string | null, companyName: string): boolean {
  if (!certificateHolderName) return false;
  return certificateHolderName.trim().toLowerCase() !== companyName.trim().toLowerCase();
}

export function DocumentReviewPage({ queueItemId }: { queueItemId: string }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [selectedPolicyTypes, setSelectedPolicyTypes] = useState<PolicyType[]>([]);
  const [confirmingApproval, setConfirmingApproval] = useState(false);

  const detail = useQuery({
    queryKey: ["review-queue-item", queueItemId],
    queryFn: () => getReviewQueueItem({ data: { queueItemId } }),
  });

  const resolve = useMutation({
    mutationFn: (
      data: { decision: "approve"; selectedPolicyTypes: PolicyType[] } | { decision: "reject" },
    ) =>
      data.decision === "approve"
        ? resolveReviewItem({
            data: {
              queueItemId,
              decision: "approve",
              selectedPolicyTypes: data.selectedPolicyTypes,
              note: note.trim() || undefined,
            },
          })
        : resolveReviewItem({
            data: {
              queueItemId,
              decision: "reject",
              note: note.trim() || undefined,
            },
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["review-queue-item", queueItemId] });
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const reprocess = useMutation({
    mutationFn: (documentId: string) => reprocessDocument({ data: { documentId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["review-queue-item", queueItemId] });
      void queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const data: ReviewQueueItemDetail | undefined = detail.data;
  const resolved = data?.queueItem.state === "resolved";
  const classifiedPolicies = useMemo(
    () =>
      (data?.document?.parsedData?.policies ?? []).filter(
        (policy): policy is typeof policy & { type: PolicyType } => policy.type !== null,
      ),
    [data?.document?.parsedData],
  );
  const availablePolicyTypes = useMemo(
    () => [...new Set(classifiedPolicies.map((policy) => policy.type))],
    [classifiedPolicies],
  );
  const availablePolicyTypesKey = availablePolicyTypes.join("|");
  const selectedPolicies = useMemo(
    () => selectClassifiedPolicies(classifiedPolicies, selectedPolicyTypes),
    [classifiedPolicies, selectedPolicyTypes],
  );

  useEffect(() => {
    setSelectedPolicyTypes(
      availablePolicyTypesKey ? (availablePolicyTypesKey.split("|") as PolicyType[]) : [],
    );
    setConfirmingApproval(false);
  }, [data?.document?.id, availablePolicyTypesKey]);

  const canApproveOrReject =
    !!data && !resolved && !!data.document && data.document.processingStatus !== "processing";

  return (
    <AppShell
      title={data ? `Review: ${data.vendor.name}` : "Review document"}
      subtitle={data ? `${data.queueItem.documentLabel} · ${data.vendor.companyName}` : "Loading…"}
      actions={
        <Link
          to="/dashboard/admin/compliance"
          className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
        >
          Back to queue
        </Link>
      }
    >
      <AdminGuard>
        {detail.isLoading ? (
          <LoadingState label="Loading review item" rows={5} />
        ) : detail.isError ? (
          <ErrorState
            description={
              detail.error instanceof Error ? detail.error.message : "Could not load this item."
            }
            onRetry={() => void detail.refetch()}
          />
        ) : !data ? (
          <EmptyState title="Not found" description="This review item does not exist." />
        ) : (
          <div className="space-y-6">
            {resolved ? (
              <p
                role="status"
                className="rounded-sm border border-border bg-muted px-3 py-2 text-xs"
              >
                Resolved as <strong>{data.queueItem.resolution}</strong>
                {data.queueItem.resolvedByEmail
                  ? ` by ${data.queueItem.resolvedByEmail}`
                  : ""} on{" "}
                {data.queueItem.resolvedAt
                  ? new Date(data.queueItem.resolvedAt).toLocaleString()
                  : "an earlier date"}
                {data.queueItem.resolutionNote ? ` — ${data.queueItem.resolutionNote}` : ""}
              </p>
            ) : null}

            <section className="rounded-md border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Document</h2>
              {!data.document ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No document is linked to this queue item.
                </p>
              ) : (
                <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">File</dt>
                    <dd className="font-medium">{data.document.fileName}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Processing status</dt>
                    <dd className="font-medium">{data.document.processingStatus}</dd>
                  </div>
                  {data.document.reviewReason ? (
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">Why this needs review</dt>
                      <dd>{data.document.reviewReason}</dd>
                    </div>
                  ) : null}
                  {data.document.processingError ? (
                    <div className="sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">Processing error</dt>
                      <dd className="text-destructive">{data.document.processingError}</dd>
                    </div>
                  ) : null}
                  {data.document.viewUrl ? (
                    <div className="sm:col-span-2">
                      <a
                        href={data.document.viewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="focusable text-sm font-medium text-primary underline underline-offset-2"
                      >
                        View original document
                      </a>
                    </div>
                  ) : null}
                </dl>
              )}

              {data.document &&
              (data.document.processingStatus === "failed" ||
                data.document.processingStatus === "needs_review") ? (
                <button
                  type="button"
                  disabled={reprocess.isPending}
                  onClick={() => data.document && reprocess.mutate(data.document.id)}
                  className="focusable mt-3 rounded-sm border border-border px-2 py-1.5 text-xs font-medium disabled:opacity-60"
                >
                  {reprocess.isPending ? "Reprocessing…" : "Reprocess"}
                </button>
              ) : null}
              {reprocess.isError ? (
                <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
                  {reprocess.error instanceof Error
                    ? reprocess.error.message
                    : "Could not reprocess this document."}
                </p>
              ) : null}
            </section>

            {data.document?.parsedData ? (
              <section className="rounded-md border border-border bg-card p-4">
                <h2 className="text-sm font-semibold text-foreground">Extracted vs. on file</h2>

                <div className="mt-3 rounded-sm border border-border bg-muted px-3 py-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Certificate holder
                  </p>
                  <p
                    className={
                      looksLikeMismatch(
                        data.document.parsedData.certificate_holder.name,
                        data.vendor.companyName,
                      )
                        ? "text-sm font-semibold text-destructive"
                        : "text-sm font-medium"
                    }
                  >
                    {data.document.parsedData.certificate_holder.name ??
                      "Not readable on this certificate"}
                  </p>
                  {data.document.parsedData.certificate_holder.address ? (
                    <p className="text-xs text-muted-foreground">
                      {data.document.parsedData.certificate_holder.address}
                    </p>
                  ) : null}
                  {looksLikeMismatch(
                    data.document.parsedData.certificate_holder.name,
                    data.vendor.companyName,
                  ) ? (
                    <p className="mt-1 text-xs font-semibold text-destructive">
                      Doesn't match "{data.vendor.companyName}" — confirm this is correct before
                      approving
                    </p>
                  ) : null}
                </div>

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <caption className="sr-only">
                      Coverage extracted from the certificate compared to the vendor's current
                      active policies
                    </caption>
                    <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          Coverage
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          Extracted
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          On file
                        </th>
                        <th scope="col" className="py-1 pr-3 font-medium">
                          Extracted expires
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          AI / WOS
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.document.parsedData.policies.map((policy, index) => {
                        const existing = policy.type
                          ? data.existingPolicies.find((p) => p.policyType === policy.type)
                          : undefined;
                        return (
                          <tr key={index} className="border-t border-border">
                            <td className="py-2 pr-3 font-medium">
                              {policy.type ? formatPolicyType(policy.type) : "Unclassified"}
                            </td>
                            <td className="py-2 pr-3">
                              {policy.carrier ?? "—"} #{policy.policy_number ?? "—"}
                            </td>
                            <td className="py-2 pr-3 text-muted-foreground">
                              {existing
                                ? `${existing.carrierName} #${existing.policyNumber}`
                                : "No active policy of this type"}
                            </td>
                            <td className="numeric py-2 pr-3">{policy.expiration_date ?? "—"}</td>
                            <td className="py-2">
                              {formatBool(policy.additional_insured)} /{" "}
                              {formatBool(policy.waiver_of_subrogation)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            {canApproveOrReject ? (
              <section className="rounded-md border border-border bg-card p-4">
                <h2 className="text-sm font-semibold text-foreground">Decision</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Select the coverage lines that should update the vendor record. Lines left
                  unchecked stay unchanged and are recorded in the review decision.
                </p>
                <fieldset className="mt-4 border-y border-border py-3">
                  <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Coverage to apply
                  </legend>
                  <div className="mt-2 space-y-2">
                    {availablePolicyTypes.map((type) => (
                      <label key={type} className="flex items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={selectedPolicyTypes.includes(type)}
                          onChange={(event) => {
                            setConfirmingApproval(false);
                            setSelectedPolicyTypes((current) =>
                              event.target.checked
                                ? [...current, type]
                                : current.filter((selected) => selected !== type),
                            );
                          }}
                          className="focusable size-4 accent-primary"
                        />
                        {formatPolicyType(type)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note for the audit trail"
                  rows={2}
                  className="focusable mt-3 w-full rounded-sm border border-input bg-background px-2 py-1.5 text-sm"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {!confirmingApproval ? (
                    <button
                      type="button"
                      disabled={resolve.isPending || selectedPolicies.length === 0}
                      onClick={() => setConfirmingApproval(true)}
                      className="focusable rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                    >
                      Review {selectedPolicies.length} selected line
                      {selectedPolicies.length === 1 ? "" : "s"}
                    </button>
                  ) : (
                    <div className="w-full rounded-sm border border-warn/40 bg-warn-soft p-3 text-xs">
                      <p className="font-semibold text-foreground">
                        Apply {selectedPolicies.length} selected coverage line
                        {selectedPolicies.length === 1 ? "" : "s"}?
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        {availablePolicyTypes.length - selectedPolicyTypes.length} line
                        {availablePolicyTypes.length - selectedPolicyTypes.length === 1
                          ? ""
                          : "s"}{" "}
                        will remain unchanged.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={resolve.isPending}
                          onClick={() =>
                            resolve.mutate({ decision: "approve", selectedPolicyTypes })
                          }
                          className="focusable rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                        >
                          {resolve.isPending && resolve.variables.decision === "approve"
                            ? "Applying…"
                            : "Confirm & apply"}
                        </button>
                        <button
                          type="button"
                          disabled={resolve.isPending}
                          onClick={() => setConfirmingApproval(false)}
                          className="focusable rounded-sm border border-border px-3 py-2 text-xs font-semibold disabled:opacity-60"
                        >
                          Edit selection
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate({ decision: "reject" })}
                    className="focusable rounded-sm border border-border px-3 py-2 text-xs font-semibold disabled:opacity-60"
                  >
                    {resolve.isPending && resolve.variables.decision === "reject"
                      ? "Rejecting…"
                      : "Reject"}
                  </button>
                </div>
                {!data.document?.parsedData ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No extracted data to approve — reprocess this document first, or reject it.
                  </p>
                ) : null}
                {resolve.isError ? (
                  <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
                    {resolve.error instanceof Error
                      ? resolve.error.message
                      : "Could not resolve this item."}
                  </p>
                ) : null}
                {resolve.isSuccess ? (
                  <p role="status" className="mt-2 text-xs">
                    {resolve.data.decision === "approve"
                      ? `Applied ${resolve.data.appliedCount} coverage line(s).${
                          resolve.data.skippedPolicyTypes.length > 0
                            ? ` ${resolve.data.skippedPolicyTypes.length} coverage line(s) were left unchanged.`
                            : ""
                        }${
                          resolve.data.errors.length > 0
                            ? ` ${resolve.data.errors.length} could not be applied — see the note above.`
                            : ""
                        }`
                      : "Rejected."}
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>
        )}
      </AdminGuard>
    </AppShell>
  );
}
