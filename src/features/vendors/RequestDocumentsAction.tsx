import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { isBackendConfigured } from "@/data/repository";
import {
  cancelUploadRequest,
  createUploadRequest,
  listUploadRequestsForVendor,
  type CreateUploadRequestResult,
} from "@/workflows/vendorUploadRequests";
import { canCancelRequest } from "@/workflows/uploadTokens";

/**
 * "Request updated certificate" action on the vendor detail page, plus the
 * outstanding-requests list a cancellation needs somewhere to live -
 * without seeing what's open, there's nothing to cancel. Closes a known
 * compromise: vendor_upload_requests.status has had 'cancelled' since
 * Phase 1, but nothing ever set it.
 *
 * Renders nothing in demo mode - VendorDetailPage keeps its existing
 * "document requests, uploads and reviews are simulated" disclaimer for that
 * case, unchanged.
 *
 * The upload link is always shown after a request is created, even when the
 * email sends successfully. RESEND_API_KEY is optional deployment
 * configuration, not a hard dependency of the workflow - an admin should be
 * able to copy the link and send it manually (Slack, a text, forwarding to a
 * broker) regardless of whether automated email is wired up.
 */

function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export function RequestDocumentsAction({ vendorId }: { vendorId: string }) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<CreateUploadRequestResult | null>(null);
  const [copied, setCopied] = useState(false);

  const requests = useQuery({
    queryKey: ["upload-requests", vendorId],
    queryFn: () => listUploadRequestsForVendor({ data: { vendorId } }),
    enabled: isBackendConfigured(),
  });

  const mutation = useMutation({
    mutationFn: () => createUploadRequest({ data: { vendorId, purpose: "renewal" } }),
    onSuccess: (data) => {
      setResult(data);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: ["upload-requests", vendorId] });
    },
  });

  const cancel = useMutation({
    mutationFn: (requestId: string) => cancelUploadRequest({ data: { requestId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["upload-requests", vendorId] });
    },
  });

  if (!isBackendConfigured()) return null;

  const copyLink = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.uploadUrl);
      setCopied(true);
    } catch {
      // Clipboard access can be denied by the browser; the link is still
      // selectable as plain text below, so this is not a dead end.
    }
  };

  return (
    <div className="mt-4 rounded-sm border border-border bg-muted px-3 py-3">
      <button
        type="button"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="focusable rounded-sm bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-60"
      >
        {mutation.isPending ? "Sending…" : "Request updated certificate"}
      </button>

      {mutation.isError ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
          {mutation.error instanceof Error ? mutation.error.message : "Could not send the request."}
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 space-y-2 text-xs">
          <p role="status">
            {result.email.status === "sent"
              ? `Email sent to ${result.email.to}.`
              : result.email.status === "failed"
                ? `Could not send email to ${result.email.to} — share the link below instead.`
                : `Email delivery is not configured — share the link below with ${result.email.to} directly.`}
          </p>
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
              onClick={() => void copyLink()}
              className="focusable shrink-0 rounded-sm border border-border px-2 py-1.5 text-[11px] font-medium"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      ) : null}

      {requests.data && requests.data.length > 0 ? (
        <ul className="mt-3 space-y-1.5 border-t border-border pt-3">
          {requests.data.map((req) => (
            <li key={req.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {formatStatus(req.status)} · requested{" "}
                {new Date(req.createdAt).toLocaleDateString()}
              </span>
              {canCancelRequest(req.status) ? (
                <button
                  type="button"
                  onClick={() => cancel.mutate(req.id)}
                  disabled={cancel.isPending}
                  className="focusable shrink-0 rounded-sm border border-border px-2 py-1 text-[11px] font-medium disabled:opacity-60"
                >
                  {cancel.isPending && cancel.variables === req.id ? "Cancelling…" : "Cancel"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {cancel.isError ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
          {cancel.error instanceof Error ? cancel.error.message : "Could not cancel the request."}
        </p>
      ) : null}
    </div>
  );
}
