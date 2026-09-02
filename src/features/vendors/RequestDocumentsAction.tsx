import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { isBackendConfigured } from "@/data/repository";
import {
  createUploadRequest,
  type CreateUploadRequestResult,
} from "@/workflows/vendorUploadRequests";

/**
 * "Request updated certificate" action on the vendor detail page.
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
export function RequestDocumentsAction({ vendorId }: { vendorId: string }) {
  const [result, setResult] = useState<CreateUploadRequestResult | null>(null);
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: () => createUploadRequest({ data: { vendorId, purpose: "renewal" } }),
    onSuccess: (data) => {
      setResult(data);
      setCopied(false);
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
    </div>
  );
}
