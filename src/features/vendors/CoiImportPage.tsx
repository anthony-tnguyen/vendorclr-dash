import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { AppShell } from "@/components/shell/AppShell";
import type { VendorTrade } from "@/data/contracts";
import { isBackendConfigured } from "@/data/repository";
import {
  parseCoiForIntake,
  createVendorsFromCoiIntake,
  type ParseCoiResult,
} from "@/workflows/coiIntake";
import { POLICY_TYPE_LABELS, VENDOR_TRADES } from "@/workflows/coiIntakeMapping";

type RiskTier = "low" | "moderate" | "high";

interface Row {
  id: string;
  fileName: string;
  state: "parsing" | "ready" | "creating" | "created" | "error";
  parse?: ParseCoiResult;
  vendorName: string;
  trade: "" | VendorTrade;
  riskTier: RiskTier;
  error?: string;
  createdVendorId?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatLimit(value: number | null): string {
  if (value == null) return "—";
  return `$${value.toLocaleString("en-US")}`;
}

function ConfidenceBadge({ parse }: { parse: ParseCoiResult }) {
  const pct = parse.confidence != null ? Math.round(parse.confidence * 100) : null;
  const low = parse.status === "needs_review" || (parse.confidence ?? 1) < 0.8;
  const cls = low ? "border-warn/40 bg-warn-soft text-warn" : "border-ok/40 bg-ok-soft text-ok";
  const label =
    parse.status === "not_configured"
      ? "No parser configured"
      : parse.status === "failed"
        ? "Could not read"
        : pct != null
          ? `${pct}% confidence`
          : "Parsed";
  return (
    <span
      className={`numeric rounded-sm border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}

const inputClass =
  "focusable w-full rounded-sm border border-input bg-background px-3 py-2 text-sm text-foreground";

export function CoiImportPage() {
  const live = isBackendConfigured();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function patchRow(id: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const id = crypto.randomUUID();
      setRows((prev) => [
        ...prev,
        {
          id,
          fileName: file.name,
          state: "parsing",
          vendorName: "",
          trade: "",
          riskTier: "moderate",
        },
      ]);
      const formData = new FormData();
      formData.append("file", file);
      try {
        const result = await parseCoiForIntake({ data: formData });
        patchRow(id, {
          state: "ready",
          parse: result,
          vendorName: result.proposal?.vendorName ?? "",
        });
      } catch (error) {
        patchRow(id, { state: "error", error: messageOf(error) });
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const creatable = rows.filter(
    (row) => row.state === "ready" && row.trade !== "" && row.vendorName.trim().length > 0,
  );

  async function createAll() {
    if (creatable.length === 0) return;
    setBusy(true);
    const batch = creatable;
    setRows((prev) =>
      prev.map((row) => (batch.some((b) => b.id === row.id) ? { ...row, state: "creating" } : row)),
    );
    try {
      const items = batch.map((row) => ({
        file: row.parse!.file,
        vendorName: row.vendorName.trim(),
        trade: row.trade as VendorTrade,
        riskTier: row.riskTier,
        confidence: row.parse!.confidence,
        extraction: row.parse!.extraction,
        policies: row.parse!.proposal?.policies ?? [],
      }));
      const { results } = await createVendorsFromCoiIntake({ data: { items } });
      setRows((prev) =>
        prev.map((row): Row => {
          const index = batch.findIndex((b) => b.id === row.id);
          if (index === -1) return row;
          const result = results[index];
          return result?.ok
            ? {
                ...row,
                state: "created",
                ...(result.vendorId ? { createdVendorId: result.vendorId } : {}),
              }
            : { ...row, state: "error", error: result?.error ?? "Could not create this vendor." };
        }),
      );
    } catch (error) {
      setRows((prev) =>
        prev.map((row) =>
          batch.some((b) => b.id === row.id)
            ? { ...row, state: "error", error: messageOf(error) }
            : row,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <div className="flex flex-wrap gap-2">
      <Link
        to="/dashboard/vendors/import"
        className="focusable rounded-sm border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground"
      >
        Import CSV instead
      </Link>
      <Link
        to="/dashboard/vendors"
        className="focusable rounded-sm border border-input bg-card px-3 py-1.5 text-xs font-semibold text-foreground"
      >
        Back to vendors
      </Link>
    </div>
  );

  if (!live) {
    return (
      <AppShell
        title="Add vendors from COIs"
        subtitle="Upload certificates you already hold"
        actions={actions}
      >
        <div className="rounded-md border border-warn/40 bg-warn-soft p-5 text-sm text-warn">
          This preview is not connected to a database, so certificates cannot be read or vendors
          created here.
        </div>
      </AppShell>
    );
  }

  const createdCount = rows.filter((r) => r.state === "created").length;

  return (
    <AppShell
      title="Add vendors from COIs"
      subtitle="Upload certificates you already hold"
      actions={actions}
    >
      <div className="space-y-5">
        <section className="rounded-md border border-border bg-card p-5">
          <h2 className="text-sm font-bold tracking-tight text-foreground">
            Upload certificates of insurance
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            We read each certificate and propose a vendor with its policies, limits and dates.
            Because a certificate does not state the vendor&apos;s trade, you set that here before
            we create anything. Nothing is created until you review and confirm below.
          </p>
          <div className="mt-4">
            <label
              htmlFor="coi-files"
              className="focusable inline-flex cursor-pointer items-center rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
            >
              Choose certificates
            </label>
            <input
              ref={fileInputRef}
              id="coi-files"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              multiple
              className="sr-only"
              onChange={(event) => void handleFiles(event.target.files)}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              PDF, PNG or JPEG. One or many at once.
            </p>
          </div>
        </section>

        {rows.length > 0 ? (
          <section className="space-y-3">
            {rows.map((row) => (
              <article key={row.id} className="rounded-md border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-foreground">{row.fileName}</p>
                  {row.state === "parsing" ? (
                    <span className="text-xs text-muted-foreground">Reading…</span>
                  ) : row.parse ? (
                    <ConfidenceBadge parse={row.parse} />
                  ) : null}
                </div>

                {row.state === "error" ? (
                  <p
                    role="alert"
                    className="mt-3 rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs font-semibold text-destructive"
                  >
                    {row.error}
                  </p>
                ) : null}

                {row.state === "created" ? (
                  <p className="mt-3 rounded-sm border border-ok/40 bg-ok-soft px-3 py-2 text-xs font-semibold text-ok">
                    Vendor created.{" "}
                    {row.createdVendorId ? (
                      <Link
                        to="/dashboard/vendors/$vendorId"
                        params={{ vendorId: row.createdVendorId }}
                        className="underline"
                      >
                        Open it
                      </Link>
                    ) : null}
                  </p>
                ) : null}

                {(row.state === "ready" || row.state === "creating") && row.parse ? (
                  <div className="mt-3 space-y-3">
                    {row.parse.status === "failed" || row.parse.status === "not_configured" ? (
                      <p className="rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
                        The certificate could not be read automatically
                        {row.parse.error ? `: ${row.parse.error}` : ""}. You can still create the
                        vendor by hand below; the file is kept on record.
                      </p>
                    ) : null}

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="sm:col-span-1">
                        <label className="block text-xs font-medium text-foreground">
                          Vendor name
                        </label>
                        <input
                          className={`mt-1 ${inputClass}`}
                          value={row.vendorName}
                          onChange={(event) => patchRow(row.id, { vendorName: event.target.value })}
                          placeholder="Business name"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-foreground">
                          Trade <span className="text-destructive">*</span>
                        </label>
                        <select
                          className={`mt-1 ${inputClass} ${row.trade === "" ? "border-warn/60" : ""}`}
                          value={row.trade}
                          onChange={(event) =>
                            patchRow(row.id, { trade: event.target.value as "" | VendorTrade })
                          }
                        >
                          <option value="">Select a trade…</option>
                          {VENDOR_TRADES.map((trade) => (
                            <option key={trade} value={trade}>
                              {trade}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-foreground">
                          Risk tier
                        </label>
                        <select
                          className={`mt-1 ${inputClass}`}
                          value={row.riskTier}
                          onChange={(event) =>
                            patchRow(row.id, { riskTier: event.target.value as RiskTier })
                          }
                        >
                          <option value="low">Low</option>
                          <option value="moderate">Moderate</option>
                          <option value="high">High</option>
                        </select>
                      </div>
                    </div>

                    {row.parse.proposal && row.parse.proposal.policies.length > 0 ? (
                      <div className="overflow-x-auto rounded-sm border border-border">
                        <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                          <thead>
                            <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                              <th className="px-2 py-1.5 font-medium">Policy</th>
                              <th className="px-2 py-1.5 font-medium">Carrier</th>
                              <th className="px-2 py-1.5 font-medium">Number</th>
                              <th className="px-2 py-1.5 font-medium">Effective</th>
                              <th className="px-2 py-1.5 font-medium">Expires</th>
                              <th className="px-2 py-1.5 font-medium">Each occ.</th>
                              <th className="px-2 py-1.5 font-medium">Aggregate</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.parse.proposal.policies.map((policy, index) => (
                              <tr
                                key={`${policy.policyType}-${index}`}
                                className="border-t border-border"
                              >
                                <td className="px-2 py-1.5">
                                  {POLICY_TYPE_LABELS[policy.policyType]}
                                </td>
                                <td className="px-2 py-1.5">{policy.carrier || "—"}</td>
                                <td className="numeric px-2 py-1.5">
                                  {policy.policyNumber || "—"}
                                </td>
                                <td className="numeric px-2 py-1.5">
                                  {policy.effectiveDate ?? "—"}
                                </td>
                                <td className="numeric px-2 py-1.5">
                                  {policy.expirationDate ?? "—"}
                                </td>
                                <td className="numeric px-2 py-1.5">
                                  {formatLimit(policy.eachOccurrenceLimit)}
                                </td>
                                <td className="numeric px-2 py-1.5">
                                  {formatLimit(policy.generalAggregateLimit)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : row.parse.status !== "failed" && row.parse.status !== "not_configured" ? (
                      <p className="text-xs text-muted-foreground">
                        No policy lines were read from this certificate. The vendor will be created
                        without policies; you can add them later.
                      </p>
                    ) : null}

                    {row.parse.proposal && row.parse.proposal.unclassifiedPolicies > 0 ? (
                      <p className="text-xs text-warn">
                        {row.parse.proposal.unclassifiedPolicies} policy line(s) could not be
                        classified and were left out.
                      </p>
                    ) : null}

                    {row.parse.proposal?.notes ? (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-semibold">Parser notes:</span>{" "}
                        {row.parse.proposal.notes}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}

        {rows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void createAll()}
              disabled={busy || creatable.length === 0}
              className="focusable rounded-sm bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {busy
                ? "Creating…"
                : creatable.length === 0
                  ? "Set a trade to create vendors"
                  : `Create ${creatable.length} vendor${creatable.length === 1 ? "" : "s"}`}
            </button>
            {createdCount > 0 ? (
              <span className="text-xs text-muted-foreground">
                {createdCount} vendor{createdCount === 1 ? "" : "s"} created so far.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
