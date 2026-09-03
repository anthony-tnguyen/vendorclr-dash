import { describe, expect, it, vi } from "vitest";

import { createWorkerExtractor } from "@/workflows/insuranceExtractionWorker";

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

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createWorkerExtractor", () => {
  it("sends the file as multipart/form-data with a bearer auth header", async () => {
    let capturedUrl: unknown;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(HIGH_CONFIDENCE_EXTRACTION);
    });

    await createWorkerExtractor("https://worker.example/extract", "secret-key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(capturedUrl).toBe("https://worker.example/extract");
    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer secret-key",
    );
    expect(capturedInit?.body).toBeInstanceOf(FormData);
    const form = capturedInit?.body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("mimeType")).toBe("application/pdf");
  });

  it("returns processed with the parsed data when the extraction is at the top level", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(HIGH_CONFIDENCE_EXTRACTION));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("processed");
    expect(result.confidence).toBe(0.95);
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
    expect(result.error).toBeNull();
  });

  it("unwraps a { data: ... } envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: HIGH_CONFIDENCE_EXTRACTION }));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("processed");
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
  });

  it("unwraps a { result: ... } envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: HIGH_CONFIDENCE_EXTRACTION }));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("processed");
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
  });

  it("routes a low-confidence but schema-valid response to needs_review, not processed", async () => {
    const lowConfidence = { ...HIGH_CONFIDENCE_EXTRACTION, overall_confidence: 0.3 };
    const fetchImpl = vi.fn(async () => jsonResponse(lowConfidence));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("needs_review");
    expect(result.confidence).toBe(0.3);
    expect(result.data).not.toBeNull();
  });

  it("routes schema-invalid JSON to needs_review with a validation error, not a throw", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nothing: "useful" }));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("needs_review");
    expect(result.data).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("normalizes a synonym policy-type string exactly like the Claude path does", async () => {
    const raw = {
      ...HIGH_CONFIDENCE_EXTRACTION,
      policies: [
        { ...HIGH_CONFIDENCE_EXTRACTION.policies[0], type: "Commercial General Liability" },
      ],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(raw));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("processed");
    expect(result.data?.policies[0]?.type).toBe("general_liability");
  });

  it("returns failed, not a thrown exception, on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, { status: 500 }));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("500");
  });

  it("returns failed when the response body is not valid JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("not valid JSON");
  });

  it("returns failed, not a thrown exception, when the network call itself errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("network down");
  });
});
