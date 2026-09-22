import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent } from "react";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import type { DocumentKind } from "@/data/dbTypeAliases";
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from "@/workflows/uploadTokens";
import {
  addPackageDocument,
  finalizePackage,
  loadPackagePortal,
  removePackageDocument,
  type PackagePortalView,
} from "@/workflows/submissionPackages";
import { resolveUploadToken } from "@/workflows/vendorUploadRequests";
import { TurnstileChallenge } from "./TurnstileChallenge";

const labels: Record<DocumentKind, string> = {
  certificate_of_insurance: "Certificate of Insurance",
  additional_insured_endorsement: "Additional Insured endorsement",
  waiver_of_subrogation_endorsement: "Waiver of Subrogation endorsement",
  primary_noncontributory_endorsement: "Primary & Non-Contributory endorsement",
  other: "Other supporting document",
};
type Queued = {
  id: string;
  file: File;
  kind: DocumentKind;
  state: "ready" | "uploading" | "error";
  error?: string;
};

function Checklist({ view }: { view: PackagePortalView }) {
  return (
    <section aria-label="Submission checklist" className="mt-4">
      <h2 className="text-sm font-semibold">Checklist</h2>
      <ul className="mt-2 divide-y rounded-md border border-border">
        {view.checklist.map((item) => {
          const doc = view.documents.find((d) => d.documentKind === item.documentKind);
          return (
            <li key={item.documentKind} className="flex justify-between gap-2 p-3 text-sm">
              <span>{labels[item.documentKind]}</span>
              <span className="rounded bg-muted px-2 py-1 text-xs">
                {doc?.status ?? (item.isRequired ? "required" : "optional")}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function UploadPackage({ token, view }: { token: string; view: PackagePortalView }) {
  const client = useQueryClient();
  const [queue, setQueue] = useState<Queued[]>([]);
  const [review, setReview] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string>();
  const [challenge, setChallenge] = useState(false);
  const kinds = view.checklist.map((item) => item.documentKind);
  const refresh = () => client.invalidateQueries({ queryKey: ["vendor-package", token] });
  const challengeFor = (error: unknown) => {
    if (
      error instanceof Error &&
      (error.name === "CaptchaRequiredError" ||
        (error as Error & { code?: string }).code === "turnstile_required")
    )
      setChallenge(true);
  };
  const add = useMutation({
    mutationFn: async (entry: Queued) => {
      const data = new FormData();
      data.set("token", token);
      data.set("packageId", view.packageId);
      data.set("documentKind", entry.kind);
      data.set("file", entry.file);
      if (captchaToken) data.set("captchaToken", captchaToken);
      return addPackageDocument({ data });
    },
    onError: challengeFor,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      removePackageDocument({
        data: { token, packageId: view.packageId, documentId: id, captchaToken },
      }),
    onSuccess: refresh,
    onError: challengeFor,
  });
  const finalize = useMutation({
    mutationFn: () => finalizePackage({ data: { token, packageId: view.packageId, captchaToken } }),
    onSuccess: (result) => setReceipt(result.packageId),
    onError: challengeFor,
  });
  const queueFiles = (files: FileList | File[]) =>
    setQueue((old) => [
      ...old,
      ...Array.from(files).map((file) => {
        const error = !ALLOWED_UPLOAD_MIME_TYPES.includes(file.type)
          ? "Upload a PDF, JPG or PNG."
          : file.size > MAX_UPLOAD_BYTES
            ? `File must be under ${Math.floor(MAX_UPLOAD_BYTES / 1048576)}MB.`
            : undefined;
        return {
          id: crypto.randomUUID(),
          file,
          kind: kinds[0] ?? "other",
          state: error ? "error" : "ready",
          error,
        } as Queued;
      }),
    ]);
  const uploadAll = async () => {
    for (const entry of queue.filter((item) => item.state === "ready")) {
      setQueue((old) =>
        old.map((item) => (item.id === entry.id ? { ...item, state: "uploading" } : item)),
      );
      try {
        await add.mutateAsync(entry);
        setQueue((old) => old.filter((item) => item.id !== entry.id));
      } catch (error) {
        setQueue((old) =>
          old.map((item) =>
            item.id === entry.id
              ? {
                  ...item,
                  state: "error",
                  error: error instanceof Error ? error.message : "Upload failed.",
                }
              : item,
          ),
        );
      }
    }
    await refresh();
  };
  if (receipt)
    return (
      <section role="status" className="mt-4 rounded-md border border-ok/40 bg-ok-soft p-5">
        <h2 className="font-semibold text-ok">Submission received</h2>
        <p className="mt-2 text-sm">Reference: {receipt}</p>
        <p className="mt-2 text-sm">
          Your submitted files are queued for processing. This does not confirm compliance. You can
          safely close this page.
        </p>
      </section>
    );
  return (
    <section aria-label="Package upload">
      <Checklist view={view} />
      <div
        className={`mt-4 rounded-md border-2 border-dashed p-6 text-center ${dragging ? "border-primary bg-accent" : "border-border"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          setDragging(false);
          queueFiles(e.dataTransfer.files);
        }}
      >
        <p className="text-sm font-medium">Drag and drop documents here</p>
        <p className="mt-1 text-xs text-muted-foreground">PDF, JPG or PNG, up to 25MB each</p>
        <label className="focusable mt-3 inline-block cursor-pointer rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
          Choose files
          <input
            aria-label="Add files"
            type="file"
            multiple
            accept={ALLOWED_UPLOAD_MIME_TYPES.join(",")}
            className="sr-only"
            onChange={(e) => {
              if (e.target.files) queueFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <ul className="mt-3 space-y-2" aria-live="polite">
        {queue.map((item) => (
          <li key={item.id} className="rounded border border-border p-3 text-sm">
            <div className="flex justify-between gap-2">
              <span>{item.file.name}</span>
              <button
                type="button"
                className="text-destructive"
                onClick={() => setQueue((old) => old.filter((entry) => entry.id !== item.id))}
              >
                Remove
              </button>
            </div>
            <label className="mt-2 block text-xs">
              Document type for {item.file.name}
              <select
                className="mt-1 block w-full rounded border p-2"
                value={item.kind}
                onChange={(e) =>
                  setQueue((old) =>
                    old.map((entry) =>
                      entry.id === item.id
                        ? { ...entry, kind: e.target.value as DocumentKind }
                        : entry,
                    ),
                  )
                }
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {labels[kind]}
                  </option>
                ))}
              </select>
            </label>
            {item.state === "uploading" ? <p className="mt-2 text-xs">Uploading…</p> : null}
            {item.error ? (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {item.error}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-2">
        {view.documents.map((doc) => (
          <li
            key={doc.id}
            className="flex justify-between gap-2 rounded border border-border p-3 text-sm"
          >
            <span>{doc.fileName}</span>
            {view.status === "open" ? (
              <button
                type="button"
                className="text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(doc.id)}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {challenge ? (
        <TurnstileChallenge
          siteKey={import.meta.env["VITE_TURNSTILE_SITE_KEY"]}
          onToken={(value) => {
            setCaptchaToken(value);
            setChallenge(false);
          }}
        />
      ) : null}
      {add.isError || remove.isError || finalize.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {(add.error ?? remove.error ?? finalize.error) instanceof Error
            ? ((add.error ?? remove.error ?? finalize.error) as Error).message
            : "Please try again."}
        </p>
      ) : null}
      {!review ? (
        <button
          type="button"
          className="mt-4 rounded bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          disabled={queue.some((item) => item.state === "error")}
          onClick={() => uploadAll().then(() => setReview(true))}
        >
          Review package
        </button>
      ) : (
        <div className="mt-4 rounded border border-border p-4">
          <h2 className="font-semibold">Review package</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Finalize to begin asynchronous processing.
          </p>
          <button
            type="button"
            className="mt-3 rounded bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            disabled={finalize.isPending}
            onClick={() => finalize.mutate()}
          >
            Finalize submission
          </button>
        </div>
      )}
    </section>
  );
}

export function VendorUploadPortal({ token }: { token: string }) {
  const request = useQuery({
    queryKey: ["vendor-upload-token", token],
    queryFn: () => resolveUploadToken({ data: { token } }),
    retry: false,
  });
  const packageQuery = useQuery({
    queryKey: ["vendor-package", token],
    queryFn: () => loadPackagePortal({ data: { token } }),
    enabled: request.isSuccess,
    retry: false,
  });
  const failed = request.isError || packageQuery.isError || !request.data || !packageQuery.data;
  return (
    <div className="flex min-h-screen justify-center bg-background px-4 py-10">
      <main className="w-full max-w-lg">
        <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
        {request.isLoading || packageQuery.isLoading ? (
          <div className="mt-3">
            <LoadingState label="Loading your request" rows={3} />
          </div>
        ) : failed ? (
          <div className="mt-3">
            <ErrorState
              title="This link isn’t working"
              description={
                request.error instanceof Error
                  ? request.error.message
                  : packageQuery.error instanceof Error
                    ? packageQuery.error.message
                    : "This link is no longer valid. Ask your contact to send a new one."
              }
            />
          </div>
        ) : (
          <div className="mt-3">
            <section
              aria-label="Request details"
              className="rounded-md border border-border bg-card p-5"
            >
              <h1 className="text-lg font-bold">{request.data.vendorName}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{request.data.companyName}</p>
              <p className="mt-3 text-sm">
                {request.data.purpose || "Please provide the requested insurance documents."}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                Secure-link expiry: {new Date(request.data.expiresAt).toLocaleDateString()}
              </p>
            </section>
            <UploadPackage token={token} view={packageQuery.data} />
            <p className="mt-6 text-xs text-muted-foreground">
              This secure link does not require a VendorClr account.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
