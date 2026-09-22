import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Vendor detail's Contacts panel and request composer: suppression is
 * visible in words, a suppressed contact cannot be chosen as a recipient,
 * the sender sees exactly who will receive the request before sending, and
 * resend re-opens the composer with the previous recipients for editing.
 */

const VENDOR = "00000000-0000-4000-8000-000000000001";
const OPS = "00000000-0000-4000-8000-0000000000a1";
const BROKER = "00000000-0000-4000-8000-0000000000b1";
const BOUNCED = "00000000-0000-4000-8000-0000000000c1";

const panelData = {
  contacts: [
    {
      vendorContactId: "vc-ops",
      contactId: OPS,
      name: "Dana Corbett",
      email: "dana@corbett.example",
      phone: "555-0100",
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
      organization: "BrokerCo Insurance",
      role: "broker",
      suppression: null,
      linkedVendorCount: 3,
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
};

const history = [
  {
    outboxId: "o1",
    createdAt: "2026-09-20T10:00:00Z",
    recipientEmail: "bea@brokerco.example",
    recipientName: "Bea Broker",
    contactId: BROKER,
    role: "broker",
    template: "renewal_request",
    requestPurpose: "renewal",
    requestId: "00000000-0000-4000-8000-00000000f001",
    requestStatus: "email_sent",
    status: "delivered",
    sent: true,
    delivered: true,
    bounced: false,
    complained: false,
    failed: false,
    suppressed: false,
    uploadReceived: false,
    error: null,
    canResend: true,
  },
  {
    outboxId: "o2",
    createdAt: "2026-09-20T10:00:00Z",
    recipientEmail: "bo@bounced.example",
    recipientName: "Bo Bounce",
    contactId: BOUNCED,
    role: "secondary",
    template: "renewal_request",
    requestPurpose: "renewal",
    requestId: "00000000-0000-4000-8000-00000000f001",
    requestStatus: "email_sent",
    status: "suppressed",
    sent: false,
    delivered: false,
    bounced: false,
    complained: false,
    failed: false,
    suppressed: true,
    uploadReceived: false,
    error: "Not sent: address is suppressed (bounced).",
    canResend: true,
  },
];

const sendRequest = vi.fn(async (_args: { data: Record<string, unknown> }) => ({
  requestId: "r2",
  uploadUrl: "https://app.example/vendor-upload/tok",
  recipients: [
    {
      contactId: OPS,
      vendorContactId: "vc-ops",
      name: "Dana Corbett",
      email: "dana@corbett.example",
      organization: "",
      role: "operational",
      outcome: "sent",
      outboxId: "o3",
      error: null,
    },
  ],
}));

vi.mock("@/workflows/vendorContacts", () => ({
  CONTACT_ROLES: ["operational", "broker", "secondary"],
  getVendorContactsPanel: vi.fn(async () => panelData),
  getCommunicationHistory: vi.fn(async () => history),
  addVendorContact: vi.fn(),
  linkExistingContact: vi.fn(),
  editContact: vi.fn(),
  changeContactRole: vi.fn(),
  unlinkVendorContact: vi.fn(),
  setRecipientSuppression: vi.fn(),
}));

vi.mock("@/workflows/communications", () => ({
  REQUEST_PURPOSES: ["renewal", "initial", "correction"],
  sendRequest: (args: { data: Record<string, unknown> }) => sendRequest(args),
}));

vi.mock("@/workflows/vendorUploadRequests", () => ({
  cancelUploadRequest: vi.fn(),
}));

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  sendRequest.mockClear();
});

describe("Contacts panel", () => {
  it("9. shows name, agency, email, phone, role and suppression state", async () => {
    const { VendorContactsPanel } = await import("@/features/vendors/VendorContactsPanel");
    render(wrap(<VendorContactsPanel vendorId={VENDOR} canWrite />));

    const bounced = await screen.findByRole("listitem", { name: "Bo Bounce, Secondary" });
    expect(within(bounced).getByText("Hard bounce")).toBeInTheDocument();
    expect(within(bounced).getByText(/hard-bounced/)).toBeInTheDocument();
    expect(within(bounced).getByRole("button", { name: "Clear suppression" })).toBeInTheDocument();

    const broker = screen.getByRole("listitem", { name: "Bea Broker, Broker" });
    expect(within(broker).getByText("BrokerCo Insurance")).toBeInTheDocument();
    expect(within(broker).getByText("bea@brokerco.example")).toBeInTheDocument();
    expect(within(broker).getByText(/Also a contact for 2 other vendors/)).toBeInTheDocument();
    expect(within(broker).queryByText("Hard bounce")).not.toBeInTheDocument();

    const ops = screen.getByRole("listitem", { name: "Dana Corbett, Operational" });
    expect(within(ops).getByText("555-0100")).toBeInTheDocument();
  });

  it("hides every write control from a read-only role but still shows suppression", async () => {
    const { VendorContactsPanel } = await import("@/features/vendors/VendorContactsPanel");
    render(wrap(<VendorContactsPanel vendorId={VENDOR} canWrite={false} />));
    await screen.findByText("Hard bounce");
    expect(screen.queryByRole("button", { name: "Add contact" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unlink/ })).not.toBeInTheDocument();
  });
});

describe("Request documents", () => {
  it("previews exactly who will receive it, excludes the suppressed contact, and sends only the chosen ids", async () => {
    const user = userEvent.setup();
    const { VendorCommunicationsSection } =
      await import("@/features/vendors/VendorCommunicationsSection");
    render(wrap(<VendorCommunicationsSection vendorId={VENDOR} canWrite />));

    await user.click(await screen.findByRole("button", { name: "Request documents" }));

    const form = screen.getByRole("form", { name: "Request documents" });
    const bouncedBox = within(form).getByRole("checkbox", { name: /Bo Bounce/ });
    expect(bouncedBox).toBeDisabled();
    expect(within(form).getByTestId("request-excluded-preview")).toHaveTextContent(
      "Bo Bounce <bo@bounced.example> — Hard bounce",
    );

    // Operational is preselected; add the broker.
    await user.click(within(form).getByRole("checkbox", { name: /Bea Broker/ }));
    const preview = within(form).getByTestId("request-recipient-preview");
    expect(preview).toHaveTextContent("Dana Corbett <dana@corbett.example> — Operational");
    expect(preview).toHaveTextContent("Bea Broker <bea@brokerco.example> — Broker");
    expect(preview).not.toHaveTextContent("Bo Bounce");

    await user.click(within(form).getByRole("button", { name: "Send to 2 recipients" }));
    await waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1));
    expect(sendRequest.mock.calls[0]![0].data).toEqual({
      vendorId: VENDOR,
      purpose: "renewal",
      confirmedRecipientIds: [OPS, BROKER],
    });
    expect(await screen.findByText(/Request created/)).toBeInTheDocument();
  });

  it("shows delivery outcomes in history and resends with editable recipients", async () => {
    const user = userEvent.setup();
    const { VendorCommunicationsSection } =
      await import("@/features/vendors/VendorCommunicationsSection");
    render(wrap(<VendorCommunicationsSection vendorId={VENDOR} canWrite />));

    const entry = await screen.findByTestId("communication-entry");
    expect(within(entry).getByText("Excluded — suppressed")).toBeInTheDocument();
    expect(within(entry).getByLabelText("Delivered: yes")).toBeInTheDocument();
    expect(within(entry).getByLabelText("Upload received: no")).toBeInTheDocument();

    await user.click(within(entry).getByRole("button", { name: "Resend" }));
    const form = screen.getByRole("form", { name: "Resend document request" });
    // Previous eligible recipient carried over; the suppressed one is not.
    expect(within(form).getByRole("checkbox", { name: /Bea Broker/ })).toBeChecked();
    expect(within(form).getByRole("checkbox", { name: /Bo Bounce/ })).not.toBeChecked();
    // Recipients stay editable.
    await user.click(within(form).getByRole("checkbox", { name: /Dana Corbett/ }));
    await user.click(within(form).getByRole("button", { name: "Send to 2 recipients" }));

    await waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1));
    expect(sendRequest.mock.calls[0]![0].data).toMatchObject({
      resendOfRequestId: "00000000-0000-4000-8000-00000000f001",
      confirmedRecipientIds: [OPS, BROKER],
    });
  });
});
