import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState, type DragEvent, type FormEvent } from "react";

import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from "@/workflows/uploadTokens";
import {
  resolveUploadToken,
  uploadDocumentForToken,
  type ResolvedUploadRequest,
} from "@/workflows/vendorUploadRequests";

/**
 * The vendor-facing counterpart to VendorDetailPage's "Request updated
 * certificate" action.
 *
 * Deliberately not the same DocumentUpload path the authenticated dashboard
 * uses: that component builds its storage path from `user.id`, and an
 * external vendor has no such session. Everything here goes through the
 * token-based server functions instead - no VendorClear account, no login.
 */

function formatPolicyTypeLabel(policyType: string): string {
  return policyType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function CurrentPolicies({ policies }: { policies: ResolvedUploadRequest["currentPolicies"] }) {
  if (policies.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        No policy currently on file for this vendor.
      </p>
    );
  }

  return (
    <table className="mt-3 w-full text-left text-sm">
      <caption className="sr-only">Insurance currently on file</caption>
      <thead className="text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th scope="col" className="py-1 pr-2 font-medium">
            Coverage
          </th>
          <th scope="col" className="py-1 pr-2 font-medium">
            Carrier
          </th>
          <th scope="col" className="py-1 pr-2 font-medium">
            Policy
          </th>
          <th scope="col" className="py-1 font-medium">
            Expires
          </th>
        </tr>
      </thead>
      <tbody>
        {policies.map((p, i) => (
          <tr key={i} className="border-t border-border">
            <th scope="row" className="py-2 pr-2 font-normal">
              {formatPolicyTypeLabel(p.policyType)}
            </th>
            <td className="py-2 pr-2 text-xs">{p.carrierName || "—"}</td>
            <td className="numeric py-2 pr-2 text-xs">{p.policyNumber || "—"}</td>
            <td className="numeric py-2 text-xs">{p.expirationDate ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UploadForm({ token, requestId }: { token: string; requestId: string }) {
  const [dragActive, setDragActive] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.set("token", token);
      formData.set("file", file);
      return uploadDocumentForToken({ data: formData });
    },
  });

  const validate = (file: File): string | null => {
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(file.type)) {
      return "Upload a PDF, JPG or PNG.";
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return `File must be under ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`;
    }
    return null;
  };

  const handleFile = (file: File) => {
    const error = validate(file);
    setValidationError(error);
    setFileName(file.name);
    if (!error) mutation.mutate(file);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  if (mutation.isSuccess) {
    return (
      <div role="status" className="rounded-md border border-ok/40 bg-ok-soft p-4 text-sm">
        <p className="font-semibold text-ok">Thanks — we received your document.</p>
        <p className="mt-1 text-foreground">
          Our team will review it and follow up if anything else is needed. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-describedby={`upload-request-${requestId}`}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`rounded-md border-2 border-dashed p-6 text-center transition-colors ${
          dragActive ? "border-primary bg-accent" : "border-border bg-card"
        }`}
      >
        <p className="text-sm font-medium text-foreground">Drag and drop your certificate here</p>
        <p className="mt-1 text-xs text-muted-foreground">PDF, JPG or PNG, up to 25MB</p>
        <label className="focusable mt-3 inline-block cursor-pointer rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
          Choose a file
          <input
            ref={inputRef}
            type="file"
            accept={ALLOWED_UPLOAD_MIME_TYPES.join(",")}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </label>
        {fileName ? (
          <p className="mt-3 text-xs text-muted-foreground">Selected: {fileName}</p>
        ) : null}
      </div>

      {validationError ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
          {validationError}
        </p>
      ) : null}

      {mutation.isError ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "The upload failed. Try again."}
        </p>
      ) : null}

      {mutation.isPending ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Uploading…
        </p>
      ) : null}
    </form>
  );
}

export function VendorUploadPortal({ token }: { token: string }) {
  const query = useQuery({
    queryKey: ["vendor-upload-token", token],
    queryFn: () => resolveUploadToken({ data: { token } }),
    retry: false,
  });

  return (
    <div className="flex min-h-screen justify-center bg-background px-4 py-10">
      <div className="w-full max-w-lg">
        <p className="text-sm font-bold tracking-tight text-foreground">VendorClear</p>

        {query.isLoading ? (
          <div className="mt-3">
            <LoadingState label="Loading your request" rows={3} />
          </div>
        ) : query.isError || !query.data ? (
          <div className="mt-3">
            <ErrorState
              title="This link isn't working"
              description={
                query.error instanceof Error
                  ? query.error.message
                  : "This link is no longer valid. Ask your contact to send a new one."
              }
            />
          </div>
        ) : (
          <div className="mt-3 rounded-md border border-border bg-card p-6">
            <h1 className="text-lg font-bold tracking-tight text-foreground">
              {query.data.vendorName}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {query.data.companyName} uses VendorClear to keep vendor insurance records current.
            </p>

            <h2 className="mt-5 text-sm font-semibold text-foreground">
              Insurance currently on file
            </h2>
            <CurrentPolicies policies={query.data.currentPolicies} />

            <h2 className="mt-6 text-sm font-semibold text-foreground">
              Upload renewed certificate
            </h2>
            <div className="mt-3">
              <UploadForm token={token} requestId={query.data.requestId} />
            </div>

            <p className="mt-6 text-xs text-muted-foreground">
              This link is unique to {query.data.vendorName} and does not require creating an
              account.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
