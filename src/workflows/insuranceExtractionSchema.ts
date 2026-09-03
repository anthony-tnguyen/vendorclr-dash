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
      "waiver_of_subrogation": boolean|null
    }
  ],
  "certificate_holder": { "name": string|null, "address": string|null },
  "overall_confidence": number,          // 0.0-1.0
  "notes": string|null
}`;

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
  automobile: "commercial_auto",
  // Bare "umbrella" is already the exact enum value, but normalizePolicyType()'s
  // exact-match check is case-sensitive - the Cloudflare Worker extractor
  // (insuranceExtractionWorker.ts) prompts its model with exactly "Umbrella" as
  // an example coverage_type, so this entry is what actually catches it.
  umbrella: "umbrella",
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

/**
 * Normalizes and validates an already-parsed JSON value against
 * InsuranceExtractionSchema - the shared second half of parseExtractionResponse()
 * below (raw model text -> JSON.parse -> here) and of the Cloudflare Worker
 * extractor's path (insuranceExtractionWorker.ts: an HTTP JSON response
 * body, already an object, straight to here). Both DocumentExtractor
 * backends run through exactly this same normalization (policy-type synonym
 * mapping) and zod validation, so which one produced a given result never
 * changes how strictly - or how leniently - it's checked.
 */
export function validateExtraction(raw: unknown): ParseResult {
  const result = InsuranceExtractionSchema.safeParse(normalizeExtraction(raw));
  if (!result.success) {
    return {
      success: false,
      data: null,
      error: result.error.issues.map((i) => i.message).join("; "),
    };
  }

  return { success: true, data: result.data, error: null };
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

  return validateExtraction(json);
}
