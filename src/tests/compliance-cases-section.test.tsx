import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The contractor-facing deficiency/exception section. The underlying engine
 * behaviors (deficiency generation, resolution, escalation clock, exception
 * expiry/reopening, suppression enforcement) are proven against real
 * Postgres in supabase/tests/compliance-cases.test.ts and
 * compliance-case-escalation.test.ts; this pins what the UI shows and what
 * it sends - and that no "Mark compliant" shortcut exists.
 */

const OPS = "00000000-0000-4000-8000-0000000000a1";
const BROKER = "00000000-0000-4000-8000-0000000000b1";
const BOUNCED = "00000000-0000-4000-8000-0000000000c1";

const VENDOR = "00000000-0000-4000-8000-000000000001";

function deficiency(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    requirementKey: "gl_each_occurrence",
    kind: "limit",
    policyType: "general_liability",
    expected: { amount: 2_000_000 },
    observed: { amount: 1_000_000 },
    explanation: "The certificate shows $1,000,000 per occurrence.",
    evidenceDocumentIds: [],
    status: "open",
    firstDetectedAt: "2026-09-15T00:00:00Z",
    updatedAt: "2026-09-15T00:00:00Z",
    resolvedAt: null,
    correctionRequestedAt: null,
    escalationLevel: 0,
    lastEscalatedAt: null,
    latestEvaluation: { evaluatedAt: "2026-09-15T00:00:00Z", packageId: "pkg-1" },
    exceptions: [],
    ...overrides,
  };
}

const caseView = {
  caseId: "00000000-0000-4000-8000-0000000000e1",
  assignmentId: "00000000-0000-4000-8000-0000000000f1",
  vendorId: VENDOR,
  projectName: "Riverbend Medical Center",
  openedAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  uploadRequestId: "00000000-0000-4000-8000-0000000000f2",
  deficiencies: [deficiency()],
  evaluationRuns: [{ id: "run-1", packageId: "pkg-1", evaluatedAt: "2026-09-15T00:00:00Z" }],
};

const getVendorCompliance = vi.fn(async (_args?: unknown) => [caseView]);
const getAssignmentCompliance = vi.fn(async (_args?: unknown) => [caseView]);
const requestCorrection = vi.fn(async (_args?: unknown) => ({ requested: 1 }));
const approveException = vi.fn(async (_args?: unknown) => ({ exceptionId: "ex-1" }));

vi.mock("@/workflows/complianceCases", () => ({
  getVendorCompliance: (args: { data: unknown }) => getVendorCompliance(args),
  getAssignmentCompliance: (args: { data: unknown }) => getAssignmentCompliance(args),
  requestCorrection: (args: { data: unknown }) => requestCorrection(args),
  approveException: (args: { data: unknown }) => approveException(args),
}));

vi.mock("@/workflows/vendorContacts", () => ({
  getVendorContactsPanel: vi.fn(async () => ({
    contacts: [
      {
        vendorContactId: "vc-ops",
        contactId: OPS,
        name: "Dana Corbett",
        email: "dana@corbett.example",
        phone: "",
        organization: "Corbett Steel",
        role: "operational",
        suppression: null,
        linkedVendorCount: 1,
      },
      {
        vendorContactId: "vc-broker",
        contactId: BROKER,
        name: "Bea Broker",
        email: "bea@brokerco.example",
        phone: "",
        organization: "BrokerCo",
        role: "broker",
        suppression: null,
        linkedVendorCount: 2,
      },
      {
        vendorContactId: "vc-bounced",
        contactId: BOUNCED,
        name: "Bo Bounce",
        email: "bo@bounced.example",
        phone: "",
        organization: "",
        role: "secondary",
        suppression: { reason: "bounced", suppressedAt: "2026-09-20T00:00:00Z" },
        linkedVendorCount: 1,
      },
    ],
    addressBook: [],
  })),
  getCommunicationHistory: vi.fn(async () => []),
}));

vi.mock("@/workflows/communications", () => ({
  sendRequest: vi.fn(async () => ({
    requestId: "r1",
    uploadUrl: "https://app.example/vendor-upload/tok",
    recipients: [],
  })),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: vi.fn(() => ({
    from: () => {
      throw new Error("no table reads expected in this test");
    },
  })),
}));

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  getVendorCompliance.mockClear();
  getAssignmentCompliance.mockClear();
  requestCorrection.mockClear();
  approveException.mockClear();
});

async function renderSection(props: { canWrite?: boolean; canApprove?: boolean } = {}) {
  const { ComplianceCasesSection } = await import("@/features/compliance/ComplianceCasesSection");
  return render(
    wrap(
      <ComplianceCasesSection
        vendorId={VENDOR}
        canWrite={props.canWrite ?? true}
        canApprove={props.canApprove ?? true}
      />,
    ),
  );
}

describe("ComplianceCasesSection", () => {
  it("shows required vs submitted values, status and dates for an open deficiency", async () => {
    await renderSection();
    const row = await screen.findByTestId("deficiency-row");
    expect(within(row).getByText("General Liability")).toBeInTheDocument();
    expect(within(row).getByText("$2,000,000")).toBeInTheDocument();
    expect(within(row).getByText("$1,000,000")).toBeInTheDocument();
    expect(within(row).getByText("Needs correction")).toBeInTheDocument();
    expect(within(row).getAllByText(/2026/).length).toBeGreaterThan(0);
    expect(within(row).getByText(/No reminder sent yet/)).toBeInTheDocument();
  });

  it("shows required and submitted amounts, first detection and escalation state", async () => {
    await renderSection({ canWrite: false });
    const row = await screen.findByTestId("deficiency-row");
    expect(within(row).getByText("$2,000,000")).toBeInTheDocument();
    expect(within(row).getByText("$1,000,000")).toBeInTheDocument();
    expect(within(row).getByText(/First detected/)).toBeInTheDocument();
  });

  it("sends a correction request through the suppression-safe path and starts the clock", async () => {
    const user = userEvent.setup();
    await renderSection();
    await screen.findByTestId("deficiency-row");
    await user.click(screen.getByRole("button", { name: "Request correction" }));

    const form = await screen.findByRole("form", { name: "Request correction" });
    // The suppressed contact is visible but cannot be chosen.
    const bounced = within(form).getByText("bo@bounced.example").closest("label")!;
    expect(within(bounced).getByRole("checkbox")).toBeDisabled();
    await user.click(
      within(form).getByText("bea@brokerco.example").closest("label")!.querySelector("input")!,
    );
    await user.click(within(form).getByRole("button", { name: /Send to 1 recipient/ }));

    await waitFor(() => expect(requestCorrection).toHaveBeenCalledTimes(1));
    expect(requestCorrection.mock.calls[0]?.[0]).toEqual({
      data: { deficiencyIds: [deficiency().id] },
    });
    const { sendRequest } = await import("@/workflows/communications");
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purpose: "correction", vendorId: VENDOR }),
      }),
    );
  });

  it("does not offer exception approval without the risk acknowledgement", async () => {
    const user = userEvent.setup();
    await renderSection();
    await screen.findByTestId("deficiency-row");
    await user.click(screen.getByRole("button", { name: "File exception" }));

    const form = await screen.findByRole("form", { name: "Approve exception" });
    const submit = within(form).getByRole("button", { name: "Approve exception" });
    await user.type(within(form).getByLabelText("Reason"), "Renewal in transit");
    fireEvent.change(within(form).getByLabelText("Effective date"), {
      target: { value: "2026-09-22" },
    });
    fireEvent.change(within(form).getByLabelText("Expiration date"), {
      target: { value: "2026-10-22" },
    });
    expect(submit).toBeDisabled();
    await user.click(within(form).getByTestId("risk-acknowledgement").querySelector("input")!);
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(approveException).toHaveBeenCalledTimes(1));
    expect(approveException.mock.calls[0]?.[0]).toEqual({
      data: expect.objectContaining({ remainingRiskAcknowledged: true }),
    });
  });

  it("shows an expired-but-not-yet-reopened waiver accurately", async () => {
    getVendorCompliance.mockImplementation(async () => [
      {
        ...caseView,
        deficiencies: [
          deficiency({
            status: "waived",
            exceptions: [
              {
                id: "ex-1",
                reason: "Renewal in transit",
                effectiveOn: "2026-09-01",
                expiresOn: "2026-09-10",
                vendorVisible: false,
                remainingRiskAcknowledged: true,
                approvedBy: "00000000-0000-4000-8000-0000000000aa",
                approvedAt: "2026-09-01T00:00:00Z",
                reopenedAt: null,
                supportingDocumentId: null,
              },
            ],
          }),
        ],
      },
    ]);
    const user = userEvent.setup();
    await renderSection({ canWrite: false, canApprove: false });
    const row = await screen.findByTestId("deficiency-row");
    expect(
      within(row).getByText(/Expired — deficiency reopens on the next sweep/),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "View detail" }));
    await waitFor(() => {
      expect(within(row).getByText("Renewal in transit")).toBeInTheDocument();
      expect(within(row).getByText(/remaining risk acknowledged/i)).toBeInTheDocument();
    });
  });

  it("offers no generic mark-compliant shortcut", async () => {
    await renderSection();
    await screen.findByTestId("deficiency-row");
    expect(document.body.textContent?.toLowerCase().includes("mark compliant")).toBe(false);
  });
});
