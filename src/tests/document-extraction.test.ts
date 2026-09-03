import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDocumentExtractor } from "@/workflows/documentExtraction";

const SAMPLE_INPUT = {
  fileBytes: new TextEncoder().encode("fake-pdf-bytes").buffer,
  mimeType: "application/pdf",
};

const HIGH_CONFIDENCE_EXTRACTION = {
  document_type: "ACORD_25",
  insured: { name: "Corbett Structural Steel", address: null },
  producer: { name: "Acme Brokers" },
  policies: [
    {
      type: "general_liability",
      carrier: "Travelers",
      policy_number: "GL-1",
      effective_date: "2025-11-30",
      expiration_date: "2026-11-30",
      limits: { each_occurrence: 2_000_000, general_aggregate: 4_000_000 },
      additional_insured: true,
      waiver_of_subrogation: true,
    },
  ],
  certificate_holder: { name: "Halstead Builders", address: null },
  overall_confidence: 0.95,
  notes: null,
};

function textMessage(text: string, overrides: Partial<Anthropic.Messages.Message> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...overrides,
  } as unknown as Anthropic.Messages.Message;
}

function mockClient(createImpl: (...args: unknown[]) => unknown): Anthropic {
  return { messages: { create: vi.fn(createImpl) } } as unknown as Anthropic;
}

describe("getDocumentExtractor - not configured", () => {
  const ORIGINAL = process.env["ANTHROPIC_API_KEY"];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = ORIGINAL;
  });

  it("returns not_configured and never throws when no API key is set", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["COI_WORKER_URL"];
    delete process.env["COI_WORKER_API_KEY"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getDocumentExtractor().extract(SAMPLE_INPUT);

    expect(result).toEqual({
      status: "not_configured",
      data: null,
      confidence: null,
      error: expect.stringContaining("not configured"),
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("getDocumentExtractor - worker precedence", () => {
  const ORIGINAL_ANTHROPIC = process.env["ANTHROPIC_API_KEY"];
  const ORIGINAL_WORKER_URL = process.env["COI_WORKER_URL"];
  const ORIGINAL_WORKER_KEY = process.env["COI_WORKER_API_KEY"];

  afterEach(() => {
    const restore = (name: string, original: string | undefined) => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    };
    restore("ANTHROPIC_API_KEY", ORIGINAL_ANTHROPIC);
    restore("COI_WORKER_URL", ORIGINAL_WORKER_URL);
    restore("COI_WORKER_API_KEY", ORIGINAL_WORKER_KEY);
  });

  it("calls the worker instead of the Anthropic client when both are configured", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-anthropic-key";
    process.env["COI_WORKER_URL"] = "https://worker.example/extract";
    process.env["COI_WORKER_API_KEY"] = "test-worker-key";

    const anthropicClient = mockClient(async () => {
      throw new Error("the Anthropic client should never be called when the worker is configured");
    });
    const workerFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(HIGH_CONFIDENCE_EXTRACTION), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await getDocumentExtractor(() => anthropicClient, workerFetch).extract(
      SAMPLE_INPUT,
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(workerFetch.mock.calls[0]?.[0]).toBe("https://worker.example/extract");
    expect(result.status).toBe("processed");
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
  });

  it("falls back to the Anthropic client when only ANTHROPIC_API_KEY is set", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-anthropic-key";
    delete process.env["COI_WORKER_URL"];
    delete process.env["COI_WORKER_API_KEY"];

    const client = mockClient(async () => textMessage(JSON.stringify(HIGH_CONFIDENCE_EXTRACTION)));

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);

    expect(result.status).toBe("processed");
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
  });

  it("falls back to the Anthropic client when COI_WORKER_URL is set but COI_WORKER_API_KEY is not", async () => {
    process.env["ANTHROPIC_API_KEY"] = "test-anthropic-key";
    process.env["COI_WORKER_URL"] = "https://worker.example/extract";
    delete process.env["COI_WORKER_API_KEY"];

    const client = mockClient(async () => textMessage(JSON.stringify(HIGH_CONFIDENCE_EXTRACTION)));

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);

    expect(result.status).toBe("processed");
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
  });
});

describe("getDocumentExtractor - configured", () => {
  const ORIGINAL = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "test-key";
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = ORIGINAL;
  });

  it("returns processed with the parsed data on a high-confidence, schema-valid response", async () => {
    const client = mockClient(async () => textMessage(JSON.stringify(HIGH_CONFIDENCE_EXTRACTION)));

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);

    expect(result.status).toBe("processed");
    expect(result.confidence).toBe(0.95);
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
    expect(result.error).toBeNull();
  });

  it("routes a low-confidence but schema-valid response to needs_review, not processed", async () => {
    const lowConfidence = { ...HIGH_CONFIDENCE_EXTRACTION, overall_confidence: 0.3 };
    const client = mockClient(async () => textMessage(JSON.stringify(lowConfidence)));

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);

    expect(result.status).toBe("needs_review");
    expect(result.confidence).toBe(0.3);
    // Low confidence is not a parsing failure - the data is still there for a reviewer to see.
    expect(result.data).not.toBeNull();
  });

  it("strips a markdown code fence around the JSON before parsing", async () => {
    const client = mockClient(async () =>
      textMessage("```json\n" + JSON.stringify(HIGH_CONFIDENCE_EXTRACTION) + "\n```"),
    );

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);
    expect(result.status).toBe("processed");
  });

  it("routes non-JSON model output to needs_review with no data, not a thrown error", async () => {
    const client = mockClient(async () => textMessage("I could not read this document."));

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);

    expect(result.status).toBe("needs_review");
    expect(result.data).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("routes schema-invalid JSON to needs_review", async () => {
    const client = mockClient(async () => textMessage(JSON.stringify({ nothing: "useful" })));

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);
    expect(result.status).toBe("needs_review");
  });

  it("returns failed, not a thrown exception, when the API call itself errors", async () => {
    const client = mockClient(async () => {
      throw new Error("network down");
    });

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("network down");
  });

  it("returns failed when the model refuses", async () => {
    const client = mockClient(async () => textMessage("", { stop_reason: "refusal", content: [] }));

    const result = await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("declined");
  });

  it("sends a PDF as a document content block and an image as an image content block", async () => {
    let capturedContent: unknown;
    const client = mockClient(async (...args: unknown[]) => {
      const opts = args[0] as { messages: Array<{ content: unknown }> };
      capturedContent = opts.messages[0]?.content;
      return textMessage(JSON.stringify(HIGH_CONFIDENCE_EXTRACTION));
    });

    await getDocumentExtractor(() => client).extract({
      ...SAMPLE_INPUT,
      mimeType: "application/pdf",
    });
    expect((capturedContent as Array<{ type: string }>)[0]?.type).toBe("document");

    await getDocumentExtractor(() => client).extract({ ...SAMPLE_INPUT, mimeType: "image/png" });
    expect((capturedContent as Array<{ type: string }>)[0]?.type).toBe("image");
  });

  it("uses claude-opus-5 and never a different model", async () => {
    let capturedModel: unknown;
    const client = mockClient(async (...args: unknown[]) => {
      const opts = args[0] as { model: unknown };
      capturedModel = opts.model;
      return textMessage(JSON.stringify(HIGH_CONFIDENCE_EXTRACTION));
    });

    await getDocumentExtractor(() => client).extract(SAMPLE_INPUT);
    expect(capturedModel).toBe("claude-opus-5");
  });
});
