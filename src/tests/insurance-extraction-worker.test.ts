import { describe, expect, it, vi } from "vitest";

import { createWorkerExtractor } from "@/workflows/insuranceExtractionWorker";

const SAMPLE_INPUT = {
  fileBytes: new TextEncoder().encode("fake-pdf-bytes").buffer,
  mimeType: "application/pdf",
};

/** Shape confirmed against the worker's actual source, read from the Cloudflare dashboard - see insuranceExtractionWorker.ts's docblock. */
const WORKER_SUCCESS_RESPONSE = {
  success: true,
  version: "1.0",
  named_insured: "Corbett Structural Steel",
  producer_agent: "Acme Brokers",
  certificate_holder: "Halstead Builders",
  compliance_status: "PASS",
  max_coverage: 2_000_000,
  missing_endorsements: null,
  policies: [
    {
      coverage_type: "Commercial General Liability",
      carrier_name: "Travelers",
      policy_number: "GL-1",
      effective_date: "2025-11-30",
      expiration_date: "2026-11-30",
      limit_each_occurrence: 2_000_000,
      additional_insured: true,
      subrogation_waived: true,
      status: "ACTIVE",
      days_until_expiration: 90,
    },
  ],
};

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createWorkerExtractor", () => {
  it("sends the file as multipart/form-data under field name 'pdfData'", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return jsonResponse(WORKER_SUCCESS_RESPONSE);
    });

    await createWorkerExtractor("https://worker.example/", "secret-key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(capturedInit?.method).toBe("POST");
    expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer secret-key",
    );
    const form = capturedInit?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("pdfData")).toBeInstanceOf(Blob);
    expect(form.get("file")).toBeNull();
  });

  it("maps the worker's real field names onto InsuranceExtractionSchema and always routes to needs_review", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(WORKER_SUCCESS_RESPONSE));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    // Always needs_review, never processed - the worker reports no confidence of its own.
    expect(result.status).toBe("needs_review");
    expect(result.error).toBeNull();
    expect(result.data?.insured.name).toBe("Corbett Structural Steel");
    expect(result.data?.producer.name).toBe("Acme Brokers");
    expect(result.data?.certificate_holder.name).toBe("Halstead Builders");
    expect(result.data?.policies[0]?.type).toBe("general_liability");
    expect(result.data?.policies[0]?.carrier).toBe("Travelers");
    expect(result.data?.policies[0]?.policy_number).toBe("GL-1");
    expect(result.data?.policies[0]?.limits.each_occurrence).toBe(2_000_000);
    // The worker never extracts general_aggregate - always null, not omitted or guessed.
    expect(result.data?.policies[0]?.limits.general_aggregate).toBeNull();
    expect(result.data?.policies[0]?.additional_insured).toBe(true);
    expect(result.data?.policies[0]?.waiver_of_subrogation).toBe(true);
  });

  it.each(["Automobile", "Umbrella", "Workers Compensation"])(
    "normalizes the worker's own prompt example coverage_type %s",
    async (coverageType) => {
      const response = {
        ...WORKER_SUCCESS_RESPONSE,
        policies: [{ ...WORKER_SUCCESS_RESPONSE.policies[0], coverage_type: coverageType }],
      };
      const fetchImpl = vi.fn(async () => jsonResponse(response));

      const result = await createWorkerExtractor(
        "https://worker.example",
        "key",
        fetchImpl,
      ).extract(SAMPLE_INPUT);

      expect(result.data?.policies[0]?.type).not.toBeNull();
    },
  );

  it("treats a 0 each_occurrence limit as not-determinable, not a real $0 limit", async () => {
    const response = {
      ...WORKER_SUCCESS_RESPONSE,
      policies: [{ ...WORKER_SUCCESS_RESPONSE.policies[0], limit_each_occurrence: 0 }],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(response));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.data?.policies[0]?.limits.each_occurrence).toBeNull();
  });

  it("folds missing_endorsements into notes for a reviewer, without acting on it", async () => {
    const response = { ...WORKER_SUCCESS_RESPONSE, missing_endorsements: ["Workers Compensation"] };
    const fetchImpl = vi.fn(async () => jsonResponse(response));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.data?.notes).toContain("Workers Compensation");
  });

  it("discards the worker's own compliance_status/max_coverage - not surfaced anywhere on the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(WORKER_SUCCESS_RESPONSE));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(JSON.stringify(result)).not.toContain("PASS");
    expect(JSON.stringify(result)).not.toContain("compliance_status");
  });

  it("returns failed, not a thrown exception, on { success: false, error } responses", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ success: false, error: "GCP Token Error: invalid_grant" }, { status: 500 }),
    );

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("GCP Token Error");
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

  it("does not crash on a malformed policies field - defaults to an empty array instead", async () => {
    const response = { ...WORKER_SUCCESS_RESPONSE, policies: "not-an-array" };
    const fetchImpl = vi.fn(async () => jsonResponse(response));

    const result = await createWorkerExtractor("https://worker.example", "key", fetchImpl).extract(
      SAMPLE_INPUT,
    );

    expect(result.status).toBe("needs_review");
    expect(result.data?.policies).toEqual([]);
  });
});
