import { describe, expect, it } from "vitest";

import {
  ExtractedPolicySchema,
  EXTRACTION_SCHEMA_VERSION,
  INSURANCE_EXTRACTION_JSON_SHAPE,
  InsuranceExtractionSchema,
  parseExtractionResponse,
} from "@/workflows/insuranceExtractionSchema";

/**
 * Task 9a's expanded extraction fields (PNC, AI ongoing/completed
 * operations, cancellation notice, employer's liability, umbrella/excess
 * follows-form, and supporting-endorsement evidence) - see
 * insuranceExtractionSchema.ts's own ExtractedPolicySchema docblock for the
 * domain reasoning behind each field's shape.
 *
 * The behavior this suite exists to prove, matching this task's own
 * definition of done ("tests prove PNC/endorsement unknowns cannot auto-
 * clear"): every new field is genuinely tri-state - an absent key or an
 * explicit null both come back as null, never silently defaulted to
 * something that reads as a confirmed answer (true, false, or an empty
 * array where an empty array would mean something different from
 * "unknown" - see endorsement_forms below). The document_extractions/
 * record_document_extraction() round-trip proof of the same property
 * against a real Postgres instance lives in
 * supabase/tests/document-extractions.test.ts - this suite covers the
 * schema/parsing layer those writes ultimately depend on.
 */

const BASE_POLICY = {
  type: "general_liability" as const,
  carrier: "Travelers",
  policy_number: "GL-1",
  effective_date: "2026-01-01",
  expiration_date: "2027-01-01",
  limits: {},
  additional_insured: true,
  waiver_of_subrogation: true,
};

describe("ExtractedPolicySchema - Task 9a fields default to null, never a coerced value", () => {
  it("defaults every new tri-state field to null when the model omits the key entirely", () => {
    const result = ExtractedPolicySchema.parse(BASE_POLICY);
    expect(result.primary_noncontributory).toBeNull();
    expect(result.additional_insured_ongoing_operations).toBeNull();
    expect(result.additional_insured_completed_operations).toBeNull();
    expect(result.cancellation_notice_provided).toBeNull();
    expect(result.cancellation_notice_days).toBeNull();
    expect(result.employers_liability).toBeNull();
    expect(result.follows_form).toBeNull();
    expect(result.endorsement_forms).toBeNull();
  });

  it("accepts an explicit null for every new field (the certificate was legible but undeterminable)", () => {
    const result = ExtractedPolicySchema.parse({
      ...BASE_POLICY,
      primary_noncontributory: null,
      additional_insured_ongoing_operations: null,
      additional_insured_completed_operations: null,
      cancellation_notice_provided: null,
      cancellation_notice_days: null,
      employers_liability: null,
      follows_form: null,
      endorsement_forms: null,
    });
    expect(result.primary_noncontributory).toBeNull();
    expect(result.endorsement_forms).toBeNull();
  });

  it("accepts a determined value for every new field without altering it", () => {
    const result = ExtractedPolicySchema.parse({
      ...BASE_POLICY,
      type: "workers_compensation",
      primary_noncontributory: true,
      additional_insured_ongoing_operations: true,
      additional_insured_completed_operations: false,
      cancellation_notice_provided: true,
      cancellation_notice_days: 30,
      employers_liability: {
        each_accident: 1_000_000,
        disease_each_employee: 1_000_000,
        disease_policy_limit: 1_000_000,
      },
      follows_form: true,
      endorsement_forms: ["CG 20 10 07 04", "CG 20 37 07 04"],
    });
    expect(result.primary_noncontributory).toBe(true);
    expect(result.additional_insured_ongoing_operations).toBe(true);
    expect(result.additional_insured_completed_operations).toBe(false);
    expect(result.cancellation_notice_days).toBe(30);
    expect(result.employers_liability).toEqual({
      each_accident: 1_000_000,
      disease_each_employee: 1_000_000,
      disease_policy_limit: 1_000_000,
    });
    expect(result.endorsement_forms).toEqual(["CG 20 10 07 04", "CG 20 37 07 04"]);
  });

  it("distinguishes endorsement_forms null (unknown) from [] (positively confirmed none)", () => {
    const unknown = ExtractedPolicySchema.parse({ ...BASE_POLICY, endorsement_forms: null });
    const confirmedNone = ExtractedPolicySchema.parse({ ...BASE_POLICY, endorsement_forms: [] });
    expect(unknown.endorsement_forms).toBeNull();
    expect(confirmedNone.endorsement_forms).toEqual([]);
    expect(unknown.endorsement_forms).not.toEqual(confirmedNone.endorsement_forms);
  });

  it("rejects a non-boolean primary_noncontributory rather than coercing it", () => {
    const result = ExtractedPolicySchema.safeParse({
      ...BASE_POLICY,
      primary_noncontributory: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer cancellation_notice_days rather than truncating it silently", () => {
    const result = ExtractedPolicySchema.safeParse({
      ...BASE_POLICY,
      cancellation_notice_days: 30.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("InsuranceExtractionSchema end-to-end via parseExtractionResponse", () => {
  it("parses a full extraction whose policies omit every Task 9a field - the whole document still validates, every new field lands null", () => {
    const raw = {
      document_type: "ACORD_25",
      insured: { name: "Corbett Structural Steel", address: null },
      producer: { name: "Acme Brokers" },
      policies: [BASE_POLICY],
      certificate_holder: { name: "Halstead Builders", address: null },
      overall_confidence: 0.9,
      notes: null,
    };
    const result = parseExtractionResponse(JSON.stringify(raw));
    expect(result.success).toBe(true);
    expect(result.data?.policies[0]?.primary_noncontributory).toBeNull();
    expect(result.data?.policies[0]?.endorsement_forms).toBeNull();
    expect(result.data?.policies[0]?.employers_liability).toBeNull();
  });

  it("a Workers Compensation line can carry employers_liability limits independently of the WC policy's own limits", () => {
    const raw = {
      document_type: "ACORD_25",
      insured: { name: "Corbett Structural Steel", address: null },
      producer: { name: "Acme Brokers" },
      policies: [
        {
          ...BASE_POLICY,
          type: "workers_compensation",
          limits: {},
          employers_liability: {
            each_accident: 500_000,
            disease_each_employee: 500_000,
            disease_policy_limit: 500_000,
          },
        },
      ],
      certificate_holder: { name: "Halstead Builders", address: null },
      overall_confidence: 0.9,
      notes: null,
    };
    const result = parseExtractionResponse(JSON.stringify(raw));
    expect(result.success).toBe(true);
    expect(result.data?.policies[0]?.employers_liability?.each_accident).toBe(500_000);
    // The WC policy's own `limits` (each_occurrence/general_aggregate) is
    // untouched by employers_liability being set - the two are genuinely
    // independent, not one overwriting the other.
    expect(result.data?.policies[0]?.limits).toEqual({});
  });
});

describe("INSURANCE_EXTRACTION_JSON_SHAPE - the prompt's own shape names every Task 9a field", () => {
  it.each([
    "primary_noncontributory",
    "additional_insured_ongoing_operations",
    "additional_insured_completed_operations",
    "cancellation_notice_provided",
    "cancellation_notice_days",
    "employers_liability",
    "follows_form",
    "endorsement_forms",
  ])("mentions %s", (field) => {
    expect(INSURANCE_EXTRACTION_JSON_SHAPE).toContain(field);
  });
});

describe("EXTRACTION_SCHEMA_VERSION", () => {
  it("is a non-empty string recorded on every model-sourced extraction attempt", () => {
    expect(typeof EXTRACTION_SCHEMA_VERSION).toBe("string");
    expect(EXTRACTION_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });
});
