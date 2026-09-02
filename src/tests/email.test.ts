import { afterEach, describe, expect, it, vi } from "vitest";

import { getEmailSender } from "@/workflows/emailSender";
import {
  renewalRequestHtml,
  renewalRequestSubject,
  renewalRequestText,
} from "@/workflows/emailTemplates";

const SAMPLE: Parameters<typeof renewalRequestSubject>[0] = {
  vendorContactName: "Dana Corbett",
  vendorName: "Corbett Structural Steel",
  companyName: "Halstead Builders",
  uploadUrl: "https://app.vendorclear.example/vendor-upload/abc123",
  currentPolicies: [
    {
      policyType: "general_liability",
      carrierName: "Travelers",
      policyNumber: "GL-8841-2266",
      expirationDate: "2026-11-30",
    },
  ],
};

describe("renewal request email templates", () => {
  it("names both companies in the subject", () => {
    expect(renewalRequestSubject(SAMPLE)).toContain("Halstead Builders");
  });

  it("includes the upload link in both text and html bodies", () => {
    expect(renewalRequestText(SAMPLE)).toContain(SAMPLE.uploadUrl);
    expect(renewalRequestHtml(SAMPLE)).toContain(SAMPLE.uploadUrl);
  });

  it("lists the current policy in the text body", () => {
    const text = renewalRequestText(SAMPLE);
    expect(text).toContain("Travelers");
    expect(text).toContain("GL-8841-2266");
    expect(text).toContain("2026-11-30");
  });

  it("escapes HTML-significant characters from vendor-controlled fields", () => {
    const html = renewalRequestHtml({
      ...SAMPLE,
      vendorName: `<script>alert(1)</script>`,
      vendorContactName: `Bob "The Builder" & Sons`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  it("handles a vendor with no policy on file without crashing", () => {
    const empty = { ...SAMPLE, currentPolicies: [] };
    expect(renewalRequestText(empty)).toContain("No policy currently on file");
    expect(renewalRequestHtml(empty)).toContain("No policy currently on file");
  });

  it("falls back to a generic greeting with no contact name", () => {
    const noName = { ...SAMPLE, vendorContactName: "" };
    expect(renewalRequestText(noName)).toContain("Hello,");
  });
});

describe("getEmailSender", () => {
  const ORIGINAL_ENV = process.env["RESEND_API_KEY"];

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env["RESEND_API_KEY"];
    else process.env["RESEND_API_KEY"] = ORIGINAL_ENV;
  });

  it("returns not_configured and never throws when no API key is set", async () => {
    delete process.env["RESEND_API_KEY"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getEmailSender().send({
      to: "dana@corbettsteel.example",
      subject: "test",
      html: "<p>test</p>",
      text: "test",
    });

    expect(result).toEqual({ status: "not_configured", providerMessageId: null, error: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sends through Resend and reports the provider message id when configured", async () => {
    process.env["RESEND_API_KEY"] = "test-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "resend-msg-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await getEmailSender(fetchMock as unknown as typeof fetch).send({
      to: "dana@corbettsteel.example",
      subject: "test",
      html: "<p>test</p>",
      text: "test",
    });

    expect(result).toEqual({ status: "sent", providerMessageId: "resend-msg-1", error: null });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });

  it("reports failure without throwing when Resend returns an error", async () => {
    process.env["RESEND_API_KEY"] = "test-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "invalid API key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await getEmailSender(fetchMock as unknown as typeof fetch).send({
      to: "dana@corbettsteel.example",
      subject: "test",
      html: "<p>test</p>",
      text: "test",
    });

    expect(result).toEqual({ status: "failed", providerMessageId: null, error: "invalid API key" });
  });

  it("reports failure without throwing when the network call itself rejects", async () => {
    process.env["RESEND_API_KEY"] = "test-key";
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await getEmailSender(fetchMock as unknown as typeof fetch).send({
      to: "dana@corbettsteel.example",
      subject: "test",
      html: "<p>test</p>",
      text: "test",
    });

    expect(result).toEqual({ status: "failed", providerMessageId: null, error: "network down" });
  });
});
