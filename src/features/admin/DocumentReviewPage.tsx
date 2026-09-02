import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  getReviewQueueItem,
  resolveReviewItem,
  type ReviewQueueItemDetail,
} from "@/workflows/documentReview";
import { reprocessDocument } from "@/workflows/vendorUploadRequests";

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

export function DocumentReviewPage({ queueItemId }: { queueItemId: string }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");

  const detail = useQuery({
    queryKey: ["review-queue-item", queueItemId],
    queryFn: () => getReviewQueueItem({ data: { queueItemId } }),
  });

  const resolve = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      resolveReviewItem({ data: { queueItemId, decision, note: note.trim() || undefined } }),
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
                Resolved as <strong>{data.queueItem.resolution}</strong> on{" "}
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
                  Approve applies every classified coverage line above to this vendor's record.
                  Reject leaves the vendor's record unchanged and closes this item.
                </p>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional note for the audit trail"
                  rows={2}
                  className="focusable mt-3 w-full rounded-sm border border-input bg-background px-2 py-1.5 text-sm"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={resolve.isPending || !data.document?.parsedData}
                    onClick={() => resolve.mutate("approve")}
                    className="focusable rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
                  >
                    {resolve.isPending && resolve.variables === "approve"
                      ? "Applying…"
                      : "Approve & apply"}
                  </button>
                  <button
                    type="button"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate("reject")}
                    className="focusable rounded-sm border border-border px-3 py-2 text-xs font-semibold disabled:opacity-60"
                  >
                    {resolve.isPending && resolve.variables === "reject" ? "Rejecting…" : "Reject"}
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
