import { z } from "zod";

/**
 * The structured shape a certificate-of-insurance extraction must validate
 * against before it is trusted enough to store. Pure schema + normalizer, no
 * I/O - kept separate from documentExtraction.ts so the shape itself (and the
 * carrier-string-to-enum mapping, which is the part most likely to need
 * tuning as real certificates come in) is unit-testable without an API key.
 *
 * Modeled on an ACORD 25 certificate, per the original workflow review this
 * phase implements: insured/producer/certificate-holder identity, one row per
 * policy (a sub can carry GL + WC + Auto + Umbrella on one certificate, same
 * reason vendor_policies is its own table rather than flat columns on
 * vendors), and a confidence score the model reports on itself.
 *
 * Every field the model might not be able to read is nullable, not optional-
 * with-a-default. A missing value must come back as an explicit `null`, never
 * silently coerced to something that looks like a real answer.
 */

// Mirrors vendor_policies.policy_type's CHECK constraint exactly - this is
// the vocabulary a successful extraction can eventually be matched against.
/**
 * Recorded on every 'model'-sourced document_extractions row
 * (record_document_extraction()'s p_prompt_version) so a later reader can
 * tell which version of this file's shape/prompt produced a given
 * attempt. Bump this string whenever ExtractedPolicySchema's fields or the
 * extraction prompt in documentExtraction.ts change in a way that affects
 * what the model is asked to return - not on every unrelated edit.
 */
export const EXTRACTION_PROVIDER = "anthropic";
export const EXTRACTION_MODEL = "claude-opus-5";
export const PARSER_VERSION = "2026-10-02-v1";
export const EXTRACTION_SCHEMA_VERSION = "2026-10-02-v1";
export const EXTRACTION_PROMPT_VERSION = "2026-10-02-v1";
export const CONFIDENCE_NEEDS_REVIEW_BELOW = 0.6;

export const POLICY_TYPES = [
  "general_liability",
  "workers_compensation",
  "commercial_auto",
  "umbrella",
  "professional_liability",
  "pollution_liability",
  "builders_risk",
] as const;

export const PolicyTypeSchema = z.enum(POLICY_TYPES);
export type PolicyType = z.infer<typeof PolicyTypeSchema>;

export const ExtractedPolicySchema = z.object({
  type: PolicyTypeSchema.nullable(),
  carrier: z.string().nullable(),
  policy_number: z.string().nullable(),
  /** ISO date (yyyy-mm-dd) or null - never a partial or ambiguous date. */
  effective_date: z.string().nullable(),
  expiration_date: z.string().nullable(),
  limits: z
    .object({
      each_occurrence: z.number().nullable(),
      general_aggregate: z.number().nullable(),
    })
    .partial(),
  // Tri-state, matching vendor_policies: null means "the certificate doesn't
  // make this determinable", not "no". These are usually shown by a checkbox
  // tied to an attached endorsement form (CG 20 10 / CG 20 37 / CG 24 04),
  // which the certificate's own text states confers no coverage on its own -
  // the extraction prompt asks the model to flag this in `notes` rather than
  // report false confidence in a checkbox reading.
  additional_insured: z.boolean().nullable(),
  waiver_of_subrogation: z.boolean().nullable(),
  // Task 9a: closes the gap noted on vendor_policies.primary_noncontributory
  // (Phase 0 column, never populated by extraction until now). Same
  // checkbox-tied-to-an-endorsement-form caveat as additional_insured above.
  primary_noncontributory: z.boolean().nullable().default(null),
  // Additional-insured coverage commonly splits into two distinct
  // endorsements on a real ACORD 25 - CG 20 10 (ongoing operations) and
  // CG 20 37 (completed operations) - each with its own checkbox/attachment.
  // `additional_insured` above is kept as the overall/general reading (no
  // existing consumer - complianceEngine.ts, apply_policy_renewal - changes
  // meaning), and these two are additive detail for whichever caller wants
  // the finer split. All three are independently tri-state: a certificate
  // can clearly show ongoing-operations coverage while leaving completed-
  // operations undeterminable, or vice versa.
  additional_insured_ongoing_operations: z.boolean().nullable().default(null),
  additional_insured_completed_operations: z.boolean().nullable().default(null),
  // Does the certificate itself show the required advance-cancellation-
  // notice language (most ACORD 25s carry standard "should any of the above
  // described policies be cancelled..." language, sometimes struck through
  // or amended by endorsement). _days is the stated notice period when
  // legible; independently nullable from _provided (a certificate can show
  // the language without a legible day count, or vice versa on a poor scan).
  cancellation_notice_provided: z.boolean().nullable().default(null),
  cancellation_notice_days: z.number().int().nullable().default(null),
  // Workers' Compensation carries its own Part Two "Employers Liability"
  // sub-coverage with its own three limits, distinct from the WC policy's
  // statutory Part One limits (which is why this is a sibling field on the
  // policy line rather than reusing `limits`, whose two keys are GL-shaped).
  // Present on every policy for schema simplicity, but only ever meaningful
  // (non-null) when type is "workers_compensation" - the prompt instructs
  // the model accordingly.
  employers_liability: z
    .object({
      each_accident: z.number().nullable(),
      disease_each_employee: z.number().nullable(),
      disease_policy_limit: z.number().nullable(),
    })
    .partial()
    .nullable()
    .default(null),
  // For an umbrella/excess policy line: does the certificate state it
  // "follows form" over (or otherwise provides excess evidence for) the
  // scheduled underlying policies. Generic on the shape rather than
  // umbrella-only so a future non-umbrella "follows form" reading (rare, but
  // not impossible on a wrap-up program) is not schema-blocked.
  follows_form: z.boolean().nullable().default(null),
  // Specific endorsement form numbers identified as attached to or
  // referenced by this policy line (e.g. "CG 20 10 07 04", "CG 24 04"). Null
  // means the certificate gives no basis to say either way (most common -
  // ACORD 25s often reference forms only via the checkbox fields above, not
  // by number); an empty array is the stronger claim "the certificate was
  // legible on this point and named no endorsement forms" - the two are
  // deliberately not collapsed into one "empty means unknown" convention.
  endorsement_forms: z.array(z.string()).nullable().default(null),
});
export type ExtractedPolicy = z.infer<typeof ExtractedPolicySchema>;

export const InsuranceExtractionSchema = z.object({
  document_type: z.string(),
  insured: z.object({ name: z.string().nullable(), address: z.string().nullable() }),
  producer: z.object({ name: z.string().nullable() }),
  policies: z.array(ExtractedPolicySchema),
  certificate_holder: z.object({ name: z.string().nullable(), address: z.string().nullable() }),
  /** The model's own confidence in this extraction as a whole, 0-1. */
  overall_confidence: z.number().min(0).max(1),
  /** Free text: anything ambiguous, unreadable, or worth a human's attention. */
  notes: z.string().nullable(),
});
export type InsuranceExtraction = z.infer<typeof InsuranceExtractionSchema>;

/** Included in the extraction prompt so the model's output matches this schema. */
export const INSURANCE_EXTRACTION_JSON_SHAPE = `{
  "document_type": string,               // e.g. "ACORD_25" or "OTHER"
  "insured": { "name": string|null, "address": string|null },
  "producer": { "name": string|null },
  "policies": [
    {
      "type": ${POLICY_TYPES.map((t) => `"${t}"`).join(" | ")} | null,
      "carrier": string|null,
      "policy_number": string|null,
      "effective_date": string|null,     // ISO date, yyyy-mm-dd
      "expiration_date": string|null,    // ISO date, yyyy-mm-dd
      "limits": { "each_occurrence": number|null, "general_aggregate": number|null },
      "additional_insured": boolean|null,
      "waiver_of_subrogation": boolean|null,
      "primary_noncontributory": boolean|null,
      "additional_insured_ongoing_operations": boolean|null,
      "additional_insured_completed_operations": boolean|null,
      "cancellation_notice_provided": boolean|null,
      "cancellation_notice_days": number|null,
      "employers_liability": { "each_accident": number|null, "disease_each_employee": number|null, "disease_policy_limit": number|null } | null,
      "follows_form": boolean|null,
      "endorsement_forms": string[]|null
    }
  ],
  "certificate_holder": { "name": string|null, "address": string|null },
  "overall_confidence": number,          // 0.0-1.0
  "notes": string|null
}`;

export const SYSTEM_PROMPT = `You extract structured data from certificates of insurance (typically ACORD 25 forms) for a construction vendor-compliance product.

Respond with ONLY a single JSON object matching this exact shape - no markdown fencing, no prose before or after:

${INSURANCE_EXTRACTION_JSON_SHAPE}

Rules:
- Extract every listed policy as a separate entry.
- A certificate usually confers no rights and does not amend coverage. Treat a checkbox or wording without the applicable attached endorsement as unverified. Use null when the endorsement page is absent, ambiguous, or unreadable.
- Additional-insured ongoing operations requires evidence of CG 20 10; completed operations requires CG 20 37; waiver of subrogation requires CG 24 04; primary and noncontributory requires CG 20 01 or explicit attached endorsement wording. Never substitute one form for another.
- endorsement_forms contains only specific form numbers actually visible on the policy line or attached endorsement. Preserve edition suffixes when legible. Use null when no reliable form evidence exists.
- Set employers_liability only for workers compensation and follows_form only for umbrella/excess.
- Use null for anything you cannot read confidently. Do not guess.
- Dates must be ISO yyyy-mm-dd or null. Amounts are numeric dollars.
- overall_confidence is 0.0-1.0 and must reflect legibility and completeness; do not inflate it.`;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeParserContractFingerprint(): string {
  return `fnv1a-${fnv1a(
    JSON.stringify({
      parserVersion: PARSER_VERSION,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      model: EXTRACTION_MODEL,
      confidenceThreshold: CONFIDENCE_NEEDS_REVIEW_BELOW,
      policyTypes: POLICY_TYPES,
      jsonShape: INSURANCE_EXTRACTION_JSON_SHAPE,
      prompt: SYSTEM_PROMPT,
    }),
  )}`;
}

export const PARSER_CONTRACT_FINGERPRINT = computeParserContractFingerprint();

export const PARSER_METADATA = {
  provider: EXTRACTION_PROVIDER,
  model: EXTRACTION_MODEL,
  parserVersion: PARSER_VERSION,
  schemaVersion: EXTRACTION_SCHEMA_VERSION,
  promptVersion: EXTRACTION_PROMPT_VERSION,
  contractFingerprint: PARSER_CONTRACT_FINGERPRINT,
} as const;

/**
 * Loose synonym -> enum mapping for the common ways a certificate or a model
 * might phrase a coverage type. Applied before schema validation so
 * "General Liability" or "Comm'l Auto" land in the right bucket instead of
 * failing validation outright over a wording difference the schema itself
 * shouldn't have to enumerate.
 */
const POLICY_TYPE_SYNONYMS: Record<string, PolicyType> = {
  "general liability": "general_liability",
  "commercial general liability": "general_liability",
  cgl: "general_liability",
  "workers compensation": "workers_compensation",
  "workers' compensation": "workers_compensation",
  "workman's compensation": "workers_compensation",
  wc: "workers_compensation",
  "commercial auto": "commercial_auto",
  "commercial auto liability": "commercial_auto",
  "auto liability": "commercial_auto",
  "business auto": "commercial_auto",
  "umbrella liability": "umbrella",
  "excess liability": "umbrella",
  "excess/umbrella liability": "umbrella",
  "professional liability": "professional_liability",
  "errors and omissions": "professional_liability",
  "e&o": "professional_liability",
  "pollution liability": "pollution_liability",
  "environmental liability": "pollution_liability",
  "builders risk": "builders_risk",
  "builder's risk": "builders_risk",
  "course of construction": "builders_risk",
};

/**
 * Normalizes a raw type string from the model into our enum, or null if it
 * matches nothing recognized. Exact enum values pass straight through.
 */
export function normalizePolicyType(raw: string | null | undefined): PolicyType | null {
  if (!raw) return null;
  const exact = PolicyTypeSchema.safeParse(raw);
  if (exact.success) return exact.data;

  const key = raw.trim().toLowerCase();
  return POLICY_TYPE_SYNONYMS[key] ?? null;
}

/**
 * Applies normalizePolicyType() to every policy's `type` field before
 * validation. The model is asked to use our exact enum values already; this
 * is a safety net for the cases where it doesn't, not the primary path.
 */
export function normalizeExtraction(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("policies" in raw)) return raw;
  const policies = (raw as { policies: unknown }).policies;
  if (!Array.isArray(policies)) return raw;

  return {
    ...raw,
    policies: policies.map((p) => {
      if (typeof p !== "object" || p === null) return p;
      const policy = p as { type?: unknown };
      return { ...policy, type: normalizePolicyType(policy.type as string | null | undefined) };
    }),
  };
}

/**
 * Strips a markdown code fence around a JSON blob, e.g. ```json ... ``` or
 * ``` ... ```. Models asked for "only JSON" still wrap it in a fence often
 * enough that this is worth handling before JSON.parse rather than failing.
 */
export function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

export interface ParseResult {
  success: boolean;
  data: InsuranceExtraction | null;
  error: string | null;
}

/** Parses, normalizes and validates model output text in one step. */
export function parseExtractionResponse(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripJsonCodeFence(text));
  } catch (error) {
    return {
      success: false,
      data: null,
      error: `Response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const result = InsuranceExtractionSchema.safeParse(normalizeExtraction(json));
  if (!result.success) {
    return {
      success: false,
      data: null,
      error: result.error.issues.map((i) => i.message).join("; "),
    };
  }

  return { success: true, data: result.data, error: null };
}
