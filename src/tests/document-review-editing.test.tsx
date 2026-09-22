import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtractionRevision, ReviewQueueItemDetail } from "@/workflows/documentReview";
import type { InsuranceExtraction } from "@/workflows/insuranceExtractionSchema";

/**
 * Reviewer editing on the document review screen.
 *
 * Invariant under test: a reviewer's edit is saved as a NEW reviewer
 * revision (saveExtractionEdit -> record_document_extraction with
 * source 'reviewer_edit'); the model's original extraction is never
 * overwritten. The database half of the invariant (a new immutable row, and
 * UPDATE on document_extractions rejected outright) is proven against real
 * Postgres in supabase/tests/document-extractions.test.ts.
 */

const MODEL: InsuranceExtraction = {
  document_type: "ACORD_25",
  insured: { name: "Cascade Steel", address: null },
  producer: { name: "Broker Co" },
  certificate_holder: { name: "Acme Builders", address: "1 Main St" },
  overall_confidence: 0.62,
  notes: null,
  policies: [
    {
      type: "general_liability",
      carrier: "Travelers",
      policy_number: "GL-1",
      effective_date: "2026-01-01",
      expiration_date: "2026-12-31",
      limits: { each_occurrence: 1000000, general_aggregate: 2000000 },
      additional_insured: true,
      waiver_of_subrogation: null,
      primary_noncontributory: null,
      additional_insured_ongoing_operations: null,
      additional_insured_completed_operations: null,
      cancellation_notice_provided: null,
      cancellation_notice_days: null,
      employers_liability: null,
      follows_form: null,
      endorsement_forms: null,
    },
  ],
};
const MODEL_SNAPSHOT = structuredClone(MODEL);

function revision(overrides: Partial<ExtractionRevision>): ExtractionRevision {
  return {
    id: "ext-model",
    source: "model",
    model: "claude-opus-5",
    promptVersion: "v1",
    confidence: 0.62,
    createdAt: "2026-09-20T10:00:00Z",
    reviewerEmail: null,
    error: null,
    parsedData: MODEL,
    current: true,
    ...overrides,
  };
}

function detail(extractions: ExtractionRevision[]): ReviewQueueItemDetail {
  const current = extractions.find((e) => e.current)!;
  return {
    queueItem: {
      id: "q-1",
      state: "needs_review",
      resolution: null,
      resolutionNote: "",
      resolvedAt: null,
      resolvedByEmail: null,
      documentLabel: "COI",
      submittedOn: "2026-09-20",
    },
    vendor: {
      id: "v-1",
      name: "Cascade Steel",
      contactName: "Ops",
      contactEmail: "ops@cascade.test",
      companyName: "Acme Builders",
    },
    document: {
      id: "11111111-1111-4111-8111-111111111111",
      fileName: "coi.pdf",
      mimeType: "application/pdf",
      processingStatus: "needs_review",
      processingError: null,
      reviewReason: "Low confidence",
      parsedData: current.parsedData,
      appliedPolicyId: null,
      viewUrl: "https://storage.test/coi.pdf",
    },
    existingPolicies: [],
    extractions,
    shortfalls: [
      {
        id: "d-1",
        requirementKey: "general_liability_each_occurrence",
        kind: "limit",
        policyType: "general_liability",
        explanation: "Each occurrence limit is below the $2,000,000 required.",
        projectName: "Harbor Tower",
      },
    ],
    history: [],
  };
}

let serverDetail = detail([revision({})]);
const getReviewQueueItem = vi.fn(async () => serverDetail);
const saveExtractionEdit = vi.fn(
  async ({ data }: { data: { documentId: string; correctedData: InsuranceExtraction } }) => {
    // What the server does: a NEW current revision; the model row is untouched.
    serverDetail = detail([
      revision({ current: false }),
      revision({
        id: "ext-reviewer",
        source: "reviewer_edit",
        model: null,
        promptVersion: null,
        confidence: null,
        reviewerEmail: "reviewer@vendorclr.test",
        createdAt: "2026-09-21T10:00:00Z",
        parsedData: data.correctedData,
        current: true,
      }),
    ]);
    return { extractionId: "ext-reviewer" };
  },
);
const resolveReviewItem = vi.fn(async ({ data }: { data: { decision: string } }) => ({
  decision: data.decision,
  appliedCount: data.decision === "approve" ? 1 : 0,
  skippedPolicyTypes: [],
  errors: [],
}));

vi.mock("@/workflows/documentReview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workflows/documentReview")>()),
  getReviewQueueItem: () => getReviewQueueItem(),
  saveExtractionEdit: (arg: never) => saveExtractionEdit(arg),
  resolveReviewItem: (arg: never) => resolveReviewItem(arg),
}));
vi.mock("@/workflows/vendorUploadRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workflows/vendorUploadRequests")>()),
  reprocessDocument: vi.fn(),
}));
vi.mock("@/app/App", () => ({
  useSession: () => ({ mode: "live", status: "authenticated", role: "admin" }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: PropsWithChildren) => <a href="#queue">{children}</a>,
}));
vi.mock("@/components/shell/AppShell", () => ({
  AppShell: ({ children, actions }: PropsWithChildren<{ actions?: ReactNode }>) => (
    <main>
      {actions}
      {children}
    </main>
  ),
}));

async function renderPage() {
  const { DocumentReviewPage } = await import("@/features/admin/DocumentReviewPage");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DocumentReviewPage queueItemId="22222222-2222-4222-8222-222222222222" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  serverDetail = detail([revision({})]);
});

describe("document review: reviewer editing", () => {
  it("shows the source document, model extraction, shortfalls and revision history", async () => {
    await renderPage();

    expect(await screen.findByRole("link", { name: "View original document" })).toBeVisible();
    expect(screen.getByTestId("review-shortfalls")).toHaveTextContent(
      "Each occurrence limit is below",
    );
    const revisions = screen.getByTestId("extraction-revisions");
    expect(revisions).toHaveTextContent("Model extraction");
    expect(revisions).toHaveTextContent("Current");
  });

  it("saves an edited field as a new reviewer revision, leaves the model extraction unchanged, then approves", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(await screen.findByRole("button", { name: "Correct extraction" }));
    const form = screen.getByRole("form", { name: "Edit extracted fields" });
    const expiration = within(form).getByLabelText("Expiration date");
    await user.clear(expiration);
    await user.type(expiration, "2027-03-31");
    await user.click(within(form).getByRole("button", { name: "Save reviewer revision" }));

    await waitFor(() => expect(saveExtractionEdit).toHaveBeenCalledTimes(1));
    const sent = saveExtractionEdit.mock.calls[0]![0].data;
    expect(sent.documentId).toBe("11111111-1111-4111-8111-111111111111");
    expect(sent.correctedData.policies[0]!.expiration_date).toBe("2027-03-31");
    // Everything else the reviewer did not touch is carried over verbatim.
    expect({ ...sent.correctedData.policies[0], expiration_date: "2026-12-31" }).toEqual(
      MODEL_SNAPSHOT.policies[0],
    );
    // The model's own extraction object was never mutated by the editor.
    expect(MODEL).toEqual(MODEL_SNAPSHOT);

    // After the refetch: two revisions, the reviewer's is current, and the
    // change is shown against the model's original value.
    const changes = await screen.findByTestId("reviewer-changes");
    const changed = within(changes).getByRole("row", { name: /Policy 1 · Expiration date/ });
    expect(changed).toHaveTextContent("2026-12-31");
    expect(changed).toHaveTextContent("2027-03-31");
    expect(screen.getByTestId("extraction-revisions")).toHaveTextContent("Reviewer revision");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The model's original extraction is unchanged",
    );

    await user.click(screen.getByRole("button", { name: /Review 1 selected line/ }));
    await user.click(screen.getByRole("button", { name: "Confirm & apply" }));
    await waitFor(() =>
      expect(resolveReviewItem).toHaveBeenCalledWith({
        data: expect.objectContaining({
          decision: "approve",
          selectedPolicyTypes: ["general_liability"],
        }),
      }),
    );
  });

  it("requires a rejection reason and keeps the internal note separate", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.type(await screen.findByLabelText(/Internal note/), "Called broker");
    await user.click(screen.getByRole("button", { name: "Reject…" }));
    const confirm = screen.getByRole("button", { name: "Confirm rejection" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/Rejection reason/), "Wrong certificate holder");
    await user.click(confirm);

    await waitFor(() =>
      expect(resolveReviewItem).toHaveBeenCalledWith({
        data: {
          queueItemId: "22222222-2222-4222-8222-222222222222",
          decision: "reject",
          note: "Wrong certificate holder\n\nInternal note: Called broker",
        },
      }),
    );
  });
});

describe("saveExtractionEditHandler()", () => {
  it("records a reviewer_edit revision through record_document_extraction and never updates document_extractions", async () => {
    const { saveExtractionEditHandler } = await import("@/workflows/documentReview");
    const touched: Array<{ table: string; op: string; payload?: unknown }> = [];
    const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
    const client = {
      from(table: string) {
        return {
          select: () => {
            touched.push({ table, op: "select" });
            return {
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "doc-1", company_id: "company-1" },
                  error: null,
                }),
              }),
            };
          },
          insert: async (payload: Record<string, unknown>) => {
            touched.push({ table, op: "insert", payload });
            return { error: null };
          },
          update: () => {
            touched.push({ table, op: "update" });
            throw new Error("update must never be called");
          },
        };
      },
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.push({ fn, params });
        return { data: "ext-new", error: null };
      },
    };

    const corrected = structuredClone(MODEL);
    corrected.policies[0]!.carrier = "Travelers Casualty";
    const result = await saveExtractionEditHandler(client, "reviewer-1", {
      documentId: "doc-1",
      correctedData: corrected,
    });

    expect(result).toEqual({ extractionId: "ext-new" });
    expect(rpcCalls).toEqual([
      {
        fn: "record_document_extraction",
        params: expect.objectContaining({
          p_document_id: "doc-1",
          p_company_id: "company-1",
          p_source: "reviewer_edit",
          p_reviewer_id: "reviewer-1",
          p_model: null,
          p_confidence: null,
          p_parsed_data: corrected,
        }),
      },
    ]);
    expect(touched.filter((t) => t.op !== "select")).toEqual([
      {
        table: "audit_log",
        op: "insert",
        payload: expect.objectContaining({
          action: "extraction_reviewer_edit",
          target_type: "vendor_document",
          target_id: "doc-1",
          detail: { extractionId: "ext-new" },
        }),
      },
    ]);
    expect(touched.some((t) => t.table === "document_extractions")).toBe(false);
  });
});
