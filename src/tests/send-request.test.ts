import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { sendRequestHandler } from "@/workflows/communications";
import type { EmailSender } from "@/workflows/emailSender";
import { toHistoryRow } from "@/workflows/vendorContacts";
import type { CommunicationHistoryEntry } from "@/data/repositories/contactRepository";

/**
 * sendRequestHandler() against a recording fake Supabase client. The
 * recipient/suppression/tenancy decisions themselves are proven against real
 * Postgres in supabase/tests/vendor-contact-requests.test.ts; this covers the
 * Node half: a fresh token per call, only eligible recipients reach the
 * email provider (with a last-moment suppression re-check), and every
 * outcome lands in email_outbox + audit_log.
 */

const VENDOR = "00000000-0000-4000-8000-000000000001";
const OPERATIONAL = "00000000-0000-4000-8000-0000000000a1";
const BROKER = "00000000-0000-4000-8000-0000000000b1";
const BOUNCED = "00000000-0000-4000-8000-0000000000c1";

interface Recorded {
  rpc: Array<{ name: string; args: Record<string, unknown> }>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
}

function fakeSupabase(options: {
  recipients: Array<{
    contactId: string;
    email: string;
    role: string;
    suppressionReason: string | null;
  }>;
  suppressedAtSendTime?: string[];
}) {
  const recorded: Recorded = { rpc: [], inserts: [], updates: [] };
  let outboxSeq = 0;

  function builder(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      insert: (row: Record<string, unknown>) => {
        op = "insert";
        payload = row;
        recorded.inserts.push({ table, row });
        return chain;
      },
      update: (values: Record<string, unknown>) => {
        op = "update";
        payload = values;
        recorded.updates.push({ table, values });
        return chain;
      },
      single: () => chain,
      maybeSingle: () => chain,
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
        if (op === "insert" && table === "email_outbox") {
          outboxSeq += 1;
          return Promise.resolve(resolve({ data: { id: `outbox-${outboxSeq}` }, error: null }));
        }
        if (op === "select" && table === "vendor_policies") {
          return Promise.resolve(resolve({ data: [], error: null }));
        }
        if (op === "select" && table === "email_outbox") {
          return Promise.resolve(resolve({ data: [], error: null }));
        }
        void payload;
        return Promise.resolve(resolve({ data: null, error: null }));
      },
    };
    return chain;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      recorded.rpc.push({ name, args });
      if (name === "prepare_contact_request") {
        return {
          data: {
            requestId: `request-${recorded.rpc.filter((r) => r.name === name).length}`,
            companyId: "company-1",
            vendorName: "Corbett Steel",
            companyName: "Halstead Builders",
            recipients: options.recipients.map((r) => ({
              ...r,
              vendorContactId: `vc-${r.contactId}`,
              name: r.email.split("@")[0],
              organization: "",
            })),
          },
          error: null,
        };
      }
      if (name === "is_email_suppressed") {
        return {
          data: (options.suppressedAtSendTime ?? []).includes(String(args["p_email"])),
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  };
  return { client: client as unknown as SupabaseClient, recorded };
}

function recordingSender() {
  const send = vi.fn<EmailSender["send"]>(async () => ({
    status: "sent" as const,
    providerMessageId: "msg-1",
    error: null,
  }));
  return { sender: { send } satisfies EmailSender, send };
}

describe("sendRequestHandler", () => {
  it("sends one request to several recipients and never mails a suppressed one", async () => {
    const { client, recorded } = fakeSupabase({
      recipients: [
        {
          contactId: OPERATIONAL,
          email: "ops@corbett.example",
          role: "operational",
          suppressionReason: null,
        },
        { contactId: BROKER, email: "bea@broker.example", role: "broker", suppressionReason: null },
        {
          contactId: BOUNCED,
          email: "bo@bounced.example",
          role: "secondary",
          suppressionReason: "bounced",
        },
      ],
    });
    const { sender, send } = recordingSender();

    const result = await sendRequestHandler(
      client,
      {
        vendorId: VENDOR,
        purpose: "renewal",
        confirmedRecipientIds: [OPERATIONAL, BROKER, BOUNCED],
      },
      { sender },
    );

    expect(send.mock.calls.map(([input]) => input.to)).toEqual([
      "ops@corbett.example",
      "bea@broker.example",
    ]);
    expect(result.recipients.map((r) => [r.role, r.outcome])).toEqual([
      ["operational", "sent"],
      ["broker", "sent"],
      ["secondary", "skipped_suppressed"],
    ]);

    // One request, one upload link shared by every recipient.
    expect(recorded.rpc.filter((r) => r.name === "prepare_contact_request")).toHaveLength(1);
    const outbox = recorded.inserts.filter((i) => i.table === "email_outbox").map((i) => i.row);
    expect(outbox).toEqual([
      expect.objectContaining({
        contact_id: OPERATIONAL,
        recipient_role: "operational",
        status: "sent",
        upload_request_id: "request-1",
      }),
      expect.objectContaining({
        contact_id: BROKER,
        recipient_role: "broker",
        status: "sent",
        upload_request_id: "request-1",
      }),
    ]);
    const audit = recorded.inserts.find((i) => i.table === "audit_log")?.row;
    expect(audit).toMatchObject({ action: "contact_request_sent", target_id: VENDOR });
    expect(recorded.updates).toContainEqual({
      table: "vendor_upload_requests",
      values: { status: "email_sent" },
    });
  });

  it("records the correction purpose on a correction-request send (broker receives, suppressed contact does not)", async () => {
    const { client, recorded } = fakeSupabase({
      recipients: [
        { contactId: BROKER, email: "bea@broker.example", role: "broker", suppressionReason: null },
        {
          contactId: BOUNCED,
          email: "bo@bounced.example",
          role: "secondary",
          suppressionReason: "manual",
        },
      ],
    });
    const { sender, send } = recordingSender();

    const result = await sendRequestHandler(
      client,
      { vendorId: VENDOR, purpose: "correction", confirmedRecipientIds: [BROKER, BOUNCED] },
      { sender },
    );

    // The purpose reaches the request row through prepare_contact_request.
    expect(recorded.rpc[0]).toMatchObject({
      name: "prepare_contact_request",
      args: expect.objectContaining({ p_purpose: "correction", p_contact_ids: [BROKER, BOUNCED] }),
    });
    expect(send.mock.calls.map(([input]) => input.to)).toEqual(["bea@broker.example"]);
    expect(result.recipients.map((r) => [r.role, r.outcome])).toEqual([
      ["broker", "sent"],
      ["secondary", "skipped_suppressed"],
    ]);
    expect(recorded.inserts.find((i) => i.table === "audit_log")?.row).toMatchObject({
      action: "contact_request_sent",
      target_id: VENDOR,
    });
  });

  it("passes the client's recipient ids to the database for re-validation instead of trusting them", async () => {
    const { client, recorded } = fakeSupabase({
      recipients: [
        { contactId: BROKER, email: "bea@broker.example", role: "broker", suppressionReason: null },
      ],
    });
    await sendRequestHandler(
      client,
      { vendorId: VENDOR, purpose: "renewal", confirmedRecipientIds: [BROKER] },
      { sender: recordingSender().sender },
    );
    expect(recorded.rpc[0]).toMatchObject({
      name: "prepare_contact_request",
      args: { p_vendor_id: VENDOR, p_contact_ids: [BROKER] },
    });
  });

  it("re-checks suppression immediately before sending (an address suppressed mid-request is not mailed)", async () => {
    const { client, recorded } = fakeSupabase({
      recipients: [
        { contactId: BROKER, email: "bea@broker.example", role: "broker", suppressionReason: null },
      ],
      suppressedAtSendTime: ["bea@broker.example"],
    });
    const { sender, send } = recordingSender();
    const result = await sendRequestHandler(
      client,
      { vendorId: VENDOR, purpose: "renewal", confirmedRecipientIds: [BROKER] },
      { sender },
    );
    expect(send).not.toHaveBeenCalled();
    expect(result.recipients[0]?.outcome).toBe("skipped_suppressed");
    expect(recorded.inserts.find((i) => i.table === "email_outbox")?.row).toMatchObject({
      status: "suppressed",
    });
  });

  it("mints a fresh token for every call, including a resend", async () => {
    const { client, recorded } = fakeSupabase({
      recipients: [
        { contactId: BROKER, email: "bea@broker.example", role: "broker", suppressionReason: null },
      ],
    });
    const { sender } = recordingSender();
    const first = await sendRequestHandler(
      client,
      { vendorId: VENDOR, purpose: "renewal", confirmedRecipientIds: [BROKER] },
      { sender },
    );
    const second = await sendRequestHandler(
      client,
      {
        vendorId: VENDOR,
        purpose: "renewal",
        confirmedRecipientIds: [BROKER],
        resendOfRequestId: "00000000-0000-4000-8000-00000000f001",
      },
      { sender },
    );
    const hashes = recorded.rpc
      .filter((r) => r.name === "prepare_contact_request")
      .map((r) => r.args["p_token_hash"]);
    expect(new Set(hashes).size).toBe(2);
    expect(first.uploadUrl).not.toBe(second.uploadUrl);
    expect(recorded.rpc[recorded.rpc.length - 2]?.args["p_resend_of_request_id"]).toBe(
      "00000000-0000-4000-8000-00000000f001",
    );
  });

  it("surfaces the database's rejection (e.g. an unrelated contact id) without sending anything", async () => {
    const { sender, send } = recordingSender();
    const client = {
      rpc: async () => ({
        data: null,
        error: { message: "Recipient x is not a contact of this vendor." },
      }),
      from: () => {
        throw new Error("nothing should be read or written");
      },
    } as unknown as SupabaseClient;
    await expect(
      sendRequestHandler(
        client,
        { vendorId: VENDOR, purpose: "renewal", confirmedRecipientIds: [BROKER] },
        { sender },
      ),
    ).rejects.toThrow(/not a contact of this vendor/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("communication history rows", () => {
  function entry(
    overrides: Partial<CommunicationHistoryEntry["outbox"]>,
    events: string[] = [],
    request: CommunicationHistoryEntry["request"] = null,
  ): CommunicationHistoryEntry {
    return {
      outbox: {
        id: "o1",
        company_id: "c",
        vendor_id: "v",
        upload_request_id: request?.id ?? null,
        template: "renewal_request",
        to_email: "bea@broker.example",
        status: "sent",
        provider_message_id: "m",
        error: null,
        sent_at: "2026-09-20T00:00:00Z",
        created_at: "2026-09-20T00:00:00Z",
        contact_id: "k1",
        recipient_role: "broker",
        ...overrides,
      },
      events: events.map((event_type, i) => ({
        id: `e${i}`,
        company_id: "c",
        email_outbox_id: "o1",
        event_type: event_type as never,
        occurred_at: "2026-09-20T00:00:00Z",
        provider_event_id: null,
        payload: {},
        created_at: "2026-09-20T00:00:00Z",
      })) as unknown as CommunicationHistoryEntry["events"],
      request,
      contactName: "Bea Broker",
    };
  }

  const request = {
    id: "r1",
    purpose: "renewal",
    status: "uploaded",
    created_at: "2026-09-20T00:00:00Z",
    uploaded_at: "2026-09-21T00:00:00Z",
    resend_of_request_id: null,
  };

  it("records sent, delivered and upload received for a request email", () => {
    const row = toHistoryRow(entry({ status: "delivered" }, ["sent", "delivered"], request));
    expect(row).toMatchObject({
      role: "broker",
      requestPurpose: "renewal",
      sent: true,
      delivered: true,
      bounced: false,
      complained: false,
      failed: false,
      uploadReceived: true,
      canResend: true,
    });
  });

  it("records bounced, complained, failed and suppressed outcomes", () => {
    expect(toHistoryRow(entry({ status: "bounced" }, ["sent", "bounced"], request)).bounced).toBe(
      true,
    );
    expect(toHistoryRow(entry({ status: "complained" }, ["complained"], request)).complained).toBe(
      true,
    );
    expect(toHistoryRow(entry({ status: "failed", error: "Resend 422" })).failed).toBe(true);
    const suppressed = toHistoryRow(entry({ status: "suppressed" }, [], request));
    expect(suppressed).toMatchObject({ suppressed: true, sent: false });
  });

  it("only offers resend for emails that carried an upload link", () => {
    expect(toHistoryRow(entry({ template: "admin_review_needed" })).canResend).toBe(false);
  });
});
