import { describe, expect, it } from "vitest";

import {
  InsuranceExtractionSchema,
  normalizePolicyType,
  parseExtractionResponse,
  stripJsonCodeFence,
} from "@/workflows/insuranceExtractionSchema";

const VALID_EXTRACTION = {
  document_type: "ACORD_25",
  insured: { name: "Corbett Structural Steel", address: "123 Main St" },
  producer: { name: "Acme Insurance Brokers" },
  policies: [
    {
      type: "general_liability",
      carrier: "Travelers",
      policy_number: "GL-8841-2266",
      effective_date: "2025-11-30",
      expiration_date: "2026-11-30",
      limits: { each_occurrence: 2_000_000, general_aggregate: 4_000_000 },
      additional_insured: true,
      waiver_of_subrogation: true,
    },
  ],
  certificate_holder: { name: "Halstead Builders", address: "456 Oak Ave" },
  overall_confidence: 0.92,
  notes: null,
};

describe("InsuranceExtractionSchema", () => {
  it("accepts a well-formed extraction", () => {
    expect(InsuranceExtractionSchema.safeParse(VALID_EXTRACTION).success).toBe(true);
  });

  it("accepts null for every field the model might not be able to read", () => {
    const allNull = {
      ...VALID_EXTRACTION,
      policies: [
        {
          type: null,
          carrier: null,
          policy_number: null,
          effective_date: null,
          expiration_date: null,
          limits: {},
          additional_insured: null,
          waiver_of_subrogation: null,
        },
      ],
      insured: { name: null, address: null },
      certificate_holder: { name: null, address: null },
      notes: "Handwriting on policy number illegible",
    };
    expect(InsuranceExtractionSchema.safeParse(allNull).success).toBe(true);
  });

  it("accepts an empty policies array for a document with no readable coverage", () => {
    expect(InsuranceExtractionSchema.safeParse({ ...VALID_EXTRACTION, policies: [] }).success).toBe(
      true,
    );
  });

  it("rejects a policy type outside the vendor_policies enum", () => {
    const bad = {
      ...VALID_EXTRACTION,
      policies: [{ ...VALID_EXTRACTION.policies[0], type: "flood" }],
    };
    expect(InsuranceExtractionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a confidence outside 0-1", () => {
    expect(
      InsuranceExtractionSchema.safeParse({ ...VALID_EXTRACTION, overall_confidence: 1.5 }).success,
    ).toBe(false);
    expect(
      InsuranceExtractionSchema.safeParse({ ...VALID_EXTRACTION, overall_confidence: -0.1 })
        .success,
    ).toBe(false);
  });
});

describe("normalizePolicyType", () => {
  it("passes exact enum values through unchanged", () => {
    expect(normalizePolicyType("workers_compensation")).toBe("workers_compensation");
  });

  it("maps common carrier-facing phrasings to the enum", () => {
    expect(normalizePolicyType("General Liability")).toBe("general_liability");
    expect(normalizePolicyType("Commercial General Liability")).toBe("general_liability");
    expect(normalizePolicyType("Workers' Compensation")).toBe("workers_compensation");
    expect(normalizePolicyType("Excess Liability")).toBe("umbrella");
    expect(normalizePolicyType("E&O")).toBe("professional_liability");
    expect(normalizePolicyType("Builder's Risk")).toBe("builders_risk");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizePolicyType("  COMMERCIAL AUTO  ")).toBe("commercial_auto");
  });

  it("returns null for unrecognized text rather than guessing", () => {
    expect(normalizePolicyType("Flood Insurance")).toBeNull();
    expect(normalizePolicyType("")).toBeNull();
    expect(normalizePolicyType(null)).toBeNull();
    expect(normalizePolicyType(undefined)).toBeNull();
  });
});

describe("stripJsonCodeFence", () => {
  it("removes a ```json fence", () => {
    expect(stripJsonCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("removes a bare ``` fence", () => {
    expect(stripJsonCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves unfenced JSON unchanged", () => {
    expect(stripJsonCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseExtractionResponse", () => {
  it("parses, normalizes and validates a fenced model response end to end", () => {
    const raw = {
      ...VALID_EXTRACTION,
      policies: [{ ...VALID_EXTRACTION.policies[0], type: "General Liability" }],
    };
    const result = parseExtractionResponse("```json\n" + JSON.stringify(raw) + "\n```");

    expect(result.success).toBe(true);
    expect(result.data?.policies[0]?.type).toBe("general_liability");
    expect(result.error).toBeNull();
  });

  it("fails cleanly on non-JSON text instead of throwing", () => {
    const result = parseExtractionResponse("I could not read this certificate clearly.");
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toContain("not valid JSON");
  });

  it("fails cleanly on JSON that does not match the schema", () => {
    const result = parseExtractionResponse(JSON.stringify({ foo: "bar" }));
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("normalizes an unrecognized policy type to null rather than rejecting the whole document", () => {
    const raw = {
      ...VALID_EXTRACTION,
      policies: [{ ...VALID_EXTRACTION.policies[0], type: "Flood Insurance" }],
    };
    const result = parseExtractionResponse(JSON.stringify(raw));
    expect(result.success).toBe(true);
    expect(result.data?.policies[0]?.type).toBeNull();
  });
});
