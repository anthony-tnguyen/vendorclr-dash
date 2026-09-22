import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type ChangeEvent } from "react";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState } from "@/components/states/AsyncState";
import { isBackendConfigured } from "@/data/repository";
import { downloadCsv } from "@/lib/download";
import { buildRejectedRowsCsv, tallyImport } from "./importResults";
import {
  EXPECTED_COLUMNS,
  executeVendorImport,
  parseAllRows,
  previewVendorImport,
  validateVendorImportRows,
  type ParsedRow,
  type ValidatedRow,
} from "@/workflows/vendorImports";

/**
 * Customer UI over Task 11a's existing pipeline (src/workflows/vendorImports.ts):
 *
 *   upload -> preview (parse in the browser, previewVendorImport/parseAllRows)
 *          -> validate (validateVendorImportRows, read-only, server-side)
 *          -> confirm (explicit checkbox - a UI step, no server call)
 *          -> execute (executeVendorImport, which re-validates, is idempotent
 *             on the key generated once per validated file, and never writes
 *             a row that fails validation).
 *
 * Nothing is written before the confirm step.
 */

const REQUIRED_COLUMNS = ["project_name", "vendor_name"] as const;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Stage = "upload" | "validated" | "done";

function actionLabel(willCreate: boolean | null, noun: string): string {
  if (willCreate === null) return `${noun}: matched or created at import`;
  return willCreate ? `Create ${noun}` : `Match ${noun}`;
}

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function VendorImportPage() {
  const { companyId, companyName, companyRole } = useSession();
  const live = isBackendConfigured();
  const canWrite = companyRole !== null && companyRole !== "read_only";

  const [stage, setStage] = useState<Stage>("upload");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [dispatchRequests, setDispatchRequests] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(newIdempotencyKey);

  const missingColumns = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  const unknownColumns = columns.filter(
    (c) => !(EXPECTED_COLUMNS as readonly string[]).includes(c),
  );

  const validate = useMutation({
    mutationFn: () => validateVendorImportRows({ data: { companyId: companyId!, rows } }),
    onSuccess: () => {
      setConfirmed(false);
      setStage("validated");
    },
  });

  const execute = useMutation({
    mutationFn: () =>
      executeVendorImport({
        data: { companyId: companyId!, idempotencyKey, rows, dispatchRequests },
      }),
    onSuccess: () => setStage("done"),
  });

  const validatedByRow = useMemo(
    () => new Map((validate.data?.results ?? []).map((r) => [r.rowNumber, r])),
    [validate.data],
  );
  const validCount = (validate.data?.results ?? []).filter((r) => r.status === "valid").length;
  const invalid = (validate.data?.results ?? []).filter((r) => r.status === "rejected");

  function reset() {
    setStage("upload");
    setFileName(null);
    setFileError(null);
    setColumns([]);
    setRows([]);
    setConfirmed(false);
    setIdempotencyKey(newIdempotencyKey());
    validate.reset();
    execute.reset();
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    reset();
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError("This file is larger than 2 MB. Split it into smaller files and import each.");
      return;
    }
    const text = await file.text();
    const preview = previewVendorImport(text);
    setFileName(file.name);
    if (preview.totalRows === 0) {
      setFileError("No data rows were found. The first line must be a header row.");
      return;
    }
    setColumns(preview.columns);
    setRows(parseAllRows(text));
  }

  const actions = (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() =>
          downloadCsv("vendorclr-import-template.csv", `${EXPECTED_COLUMNS.join(",")}\r\n`)
        }
        className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
      >
        Download template
      </button>
      <Link
        to="/dashboard/vendors"
        className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
      >
        Back to vendors
      </Link>
    </div>
  );

  if (!live || !companyId) {
    return (
      <AppShell title="Import vendors" subtitle="Bulk CSV onboarding" actions={actions}>
        <EmptyState
          title={live ? "No company workspace" : "Import needs a live workspace"}
          description={
            live
              ? "CSV import is available once your account belongs to an activated company."
              : "Sample-data mode has no database to import into. Nothing can be uploaded here."
          }
        />
      </AppShell>
    );
  }

  if (!canWrite) {
    return (
      <AppShell title="Import vendors" subtitle="Bulk CSV onboarding" actions={actions}>
        <EmptyState
          title="Read-only access"
          description="Your role can view this company's data but cannot import into it. Ask an owner, risk manager or project engineer."
        />
      </AppShell>
    );
  }

  const tallies = execute.data ? tallyImport(execute.data) : null;

  return (
    <AppShell
      title="Import vendors"
      subtitle={`Create or match projects, vendors and assignments for ${companyName} from a CSV file.`}
      actions={actions}
    >
      <div className="space-y-6">
        <section
          aria-labelledby="import-upload"
          className="rounded-md border border-border bg-card p-4"
        >
          <h2 id="import-upload" className="text-sm font-semibold">
            1. Upload
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Columns: {EXPECTED_COLUMNS.join(", ")}. Only project_name and vendor_name are required.
            Existing projects are matched by exact name; vendors by name or contact email.
          </p>
          <label className="focusable mt-3 inline-block cursor-pointer rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
            {fileName ? "Choose a different file" : "Choose CSV file"}
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="CSV file"
              className="sr-only"
              onChange={(e) => void onFile(e)}
              disabled={execute.isPending}
            />
          </label>
          {fileName ? <p className="mt-2 text-xs">Selected: {fileName}</p> : null}
          {fileError ? (
            <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
              {fileError}
            </p>
          ) : null}
        </section>

        {rows.length > 0 && stage !== "done" ? (
          <section
            aria-labelledby="import-preview"
            className="rounded-md border border-border bg-card p-4"
          >
            <h2 id="import-preview" className="text-sm font-semibold">
              2. Preview — {rows.length} row{rows.length === 1 ? "" : "s"}
            </h2>
            {missingColumns.length > 0 ? (
              <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
                Missing required column{missingColumns.length === 1 ? "" : "s"}:{" "}
                {missingColumns.join(", ")}. Every row will be rejected until the header is fixed.
              </p>
            ) : null}
            {unknownColumns.length > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Ignored column{unknownColumns.length === 1 ? "" : "s"}: {unknownColumns.join(", ")}
              </p>
            ) : null}
            <div className="mt-3 max-h-96 overflow-auto rounded-sm border border-border">
              <table className="w-full min-w-[720px] text-left text-xs" data-testid="import-rows">
                <caption className="sr-only">Parsed CSV rows and proposed actions</caption>
                <thead className="sticky top-0 bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-2 py-1.5">
                      Row
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Project
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Vendor
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Trade
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Contact email
                    </th>
                    <th scope="col" className="px-2 py-1.5">
                      Request
                    </th>
                    {stage === "validated" ? (
                      <>
                        <th scope="col" className="px-2 py-1.5">
                          Status
                        </th>
                        <th scope="col" className="px-2 py-1.5">
                          Proposed actions
                        </th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const v: ValidatedRow | undefined = validatedByRow.get(row.rowNumber);
                    return (
                      <tr key={row.rowNumber} className="border-t border-border align-top">
                        <th scope="row" className="px-2 py-1.5 font-medium">
                          {row.rowNumber}
                        </th>
                        <td className="px-2 py-1.5">{row.projectName || "—"}</td>
                        <td className="px-2 py-1.5">{row.vendorName || "—"}</td>
                        <td className="px-2 py-1.5">{row.trade || "—"}</td>
                        <td className="px-2 py-1.5">{row.contactEmail || "—"}</td>
                        <td className="px-2 py-1.5">{row.dispatchRequest ? "Yes" : "No"}</td>
                        {stage === "validated" && v ? (
                          <>
                            <td className="px-2 py-1.5">
                              {v.status === "valid" ? (
                                <span className="font-semibold text-ok">Valid</span>
                              ) : (
                                <span className="font-semibold text-destructive">Rejected</span>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              {v.status === "valid" ? (
                                <ul className="space-y-0.5">
                                  <li>{actionLabel(v.willCreateProject, "project")}</li>
                                  <li>{actionLabel(v.willCreateVendor, "vendor")}</li>
                                  <li>
                                    {v.willCreateAssignment === false
                                      ? "Match existing assignment"
                                      : actionLabel(v.willCreateAssignment, "assignment")}
                                  </li>
                                  {row.dispatchRequest && dispatchRequests ? (
                                    <li>Send upload request</li>
                                  ) : null}
                                </ul>
                              ) : (
                                <span className="text-muted-foreground">Not written</span>
                              )}
                            </td>
                          </>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <label className="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={dispatchRequests}
                onChange={(e) => {
                  setDispatchRequests(e.target.checked);
                  setConfirmed(false);
                }}
                className="focusable mt-0.5 size-4 accent-primary"
              />
              <span>
                Send an upload request to each vendor whose row has dispatch_request set to true
                <span className="block text-xs text-muted-foreground">
                  Sent to the vendor's operational contact. Suppressed addresses are skipped. A
                  failed send never undoes that row's import.
                </span>
              </span>
            </label>

            {stage === "upload" ? (
              <button
                type="button"
                disabled={validate.isPending}
                onClick={() => validate.mutate()}
                className="focusable mt-3 rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
              >
                {validate.isPending
                  ? "Validating…"
                  : `Validate ${rows.length} row${rows.length === 1 ? "" : "s"}`}
              </button>
            ) : null}
            {validate.isError ? (
              <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
                {validate.error instanceof Error
                  ? validate.error.message
                  : "Could not validate this file."}
              </p>
            ) : null}
          </section>
        ) : null}

        {stage === "validated" ? (
          <section
            aria-labelledby="import-validation"
            className="rounded-md border border-border bg-card p-4"
          >
            <h2 id="import-validation" className="text-sm font-semibold">
              3. Validation — {validCount} valid, {invalid.length} rejected
            </h2>
            {invalid.length > 0 ? (
              <div className="mt-3 overflow-x-auto rounded-sm border border-border">
                <table className="w-full text-left text-xs" data-testid="import-errors">
                  <caption className="sr-only">Validation errors by row and column</caption>
                  <thead className="bg-muted text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-2 py-1.5">
                        Row
                      </th>
                      <th scope="col" className="px-2 py-1.5">
                        Column
                      </th>
                      <th scope="col" className="px-2 py-1.5">
                        Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invalid.flatMap((r) =>
                      r.errors.map((e, i) => (
                        <tr key={`${r.rowNumber}-${i}`} className="border-t border-border">
                          <th scope="row" className="px-2 py-1.5 font-medium">
                            {r.rowNumber}
                          </th>
                          <td className="px-2 py-1.5">{e.field}</td>
                          <td className="px-2 py-1.5">{e.reason}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Every row passed validation.</p>
            )}

            <div className="mt-4 rounded-sm border border-warn/40 bg-warn-soft p-3 text-sm">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  disabled={validCount === 0}
                  className="focusable mt-0.5 size-4 accent-primary"
                />
                <span>
                  I've reviewed the proposed actions. Import {validCount} valid row
                  {validCount === 1 ? "" : "s"}
                  {invalid.length > 0
                    ? `; the ${invalid.length} rejected row${invalid.length === 1 ? "" : "s"} will not be written`
                    : ""}
                  .
                </span>
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!confirmed || validCount === 0 || execute.isPending}
                  onClick={() => execute.mutate()}
                  className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {execute.isPending
                    ? "Importing…"
                    : `Import ${validCount} row${validCount === 1 ? "" : "s"}`}
                </button>
                <button
                  type="button"
                  disabled={execute.isPending}
                  onClick={reset}
                  className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
                >
                  Start over
                </button>
              </div>
              {execute.isError ? (
                <p role="alert" className="mt-2 text-xs font-semibold text-destructive">
                  {execute.error instanceof Error
                    ? execute.error.message
                    : "The import did not complete."}{" "}
                  Retrying is safe: the same import is never applied twice.
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {stage === "done" && execute.data && tallies ? (
          <section
            aria-labelledby="import-results"
            className="rounded-md border border-ok/40 bg-ok-soft p-4"
          >
            <h2 id="import-results" className="text-sm font-semibold">
              Import complete
            </h2>
            {execute.data.idempotentReplay ? (
              <p className="mt-1 text-xs">
                This file had already been imported; these are the original results. Nothing was
                written again.
              </p>
            ) : null}
            <dl
              className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4"
              data-testid="import-results"
            >
              {(
                [
                  ["Processed", tallies.processed],
                  ["Imported", tallies.accepted],
                  ["Projects created", tallies.projectsCreated],
                  ["Projects matched", tallies.projectsMatched],
                  ["Vendors created", tallies.vendorsCreated],
                  ["Vendors matched", tallies.vendorsMatched],
                  ["Assignments created", tallies.assignmentsCreated],
                  ["Assignments matched", tallies.assignmentsMatched],
                  ["Skipped (failed validation)", tallies.skipped],
                  ["Rejected at write", tallies.rejectedAtWrite],
                  ["Upload requests sent", tallies.requestsSent],
                  ["Request-send failures", tallies.requestFailures],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="numeric font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            {execute.data.rowResults.some((r) => r.dispatch && r.dispatch.status !== "sent") ? (
              <ul className="mt-3 space-y-0.5 text-xs">
                {execute.data.rowResults
                  .filter((r) => r.dispatch && r.dispatch.status !== "sent")
                  .map((r) => (
                    <li key={r.rowNumber}>
                      Row {r.rowNumber}: request {r.dispatch!.status.replaceAll("_", " ")}
                      {r.dispatch!.error ? ` — ${r.dispatch!.error}` : ""}
                    </li>
                  ))}
              </ul>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {execute.data.rejectedRows > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    downloadCsv(
                      "vendorclr-import-rejected-rows.csv",
                      buildRejectedRowsCsv(rows, execute.data!.rowResults),
                    )
                  }
                  className="focusable rounded-sm border border-border bg-card px-3 py-2 text-sm font-medium"
                >
                  Download rejected rows ({execute.data.rejectedRows})
                </button>
              ) : null}
              <Link
                to="/dashboard/vendors"
                className="focusable rounded-sm border border-border bg-card px-3 py-2 text-sm font-medium"
              >
                View vendors
              </Link>
              <Link
                to="/dashboard/projects"
                className="focusable rounded-sm border border-border bg-card px-3 py-2 text-sm font-medium"
              >
                View projects
              </Link>
              <button
                type="button"
                onClick={reset}
                className="focusable rounded-sm border border-border bg-card px-3 py-2 text-sm font-medium"
              >
                Import another file
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
