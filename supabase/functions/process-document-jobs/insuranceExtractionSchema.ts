// Byte-for-byte the same schema/logic as
// src/workflows/insuranceExtractionSchema.ts and
// retry-failed-documents/insuranceExtractionSchema.ts, except for the zod
// import specifier (npm: here, a bare package name in the Node original).
// Duplicated rather than imported: this function runs in Supabase's Deno
// Edge Runtime, a separate deployment target from the Node/Cloudflare app,
// with no shared build step across that boundary in this project - same
// reasoning as send-renewal-reminders/uploadTokens.ts. If one copy changes,
// check the other two.
import { z } from "npm:zod@3.25.76";

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

// Kept byte-for-byte in sync with src/workflows/insuranceExtractionSchema.ts's
// own ExtractedPolicySchema - see this file's top docblock. Task 9a added the
// primary_noncontributory/additional_insured_ongoing_operations/
// additional_insured_completed_operations/cancellation_notice_*/
// employers_liability/follows_form/endorsement_forms fields there; ported
// here unchanged (field-for-field, comment-for-comment reasoning omitted -
// see the Node original for the full rationale on each).
export const ExtractedPolicySchema = z.object({
  type: PolicyTypeSchema.nullable(),
  carrier: z.string().nullable(),
  policy_number: z.string().nullable(),
  effective_date: z.string().nullable(),
  expiration_date: z.string().nullable(),
  limits: z
    .object({
      each_occurrence: z.number().nullable(),
      general_aggregate: z.number().nullable(),
    })
    .partial(),
  additional_insured: z.boolean().nullable(),
  waiver_of_subrogation: z.boolean().nullable(),
  primary_noncontributory: z.boolean().nullable().default(null),
  additional_insured_ongoing_operations: z.boolean().nullable().default(null),
  additional_insured_completed_operations: z.boolean().nullable().default(null),
  cancellation_notice_provided: z.boolean().nullable().default(null),
  cancellation_notice_days: z.number().int().nullable().default(null),
  employers_liability: z
    .object({
      each_accident: z.number().nullable(),
      disease_each_employee: z.number().nullable(),
      disease_policy_limit: z.number().nullable(),
    })
    .partial()
    .nullable()
    .default(null),
  follows_form: z.boolean().nullable().default(null),
  endorsement_forms: z.array(z.string()).nullable().default(null),
});
export type ExtractedPolicy = z.infer<typeof ExtractedPolicySchema>;

export const InsuranceExtractionSchema = z.object({
  document_type: z.string(),
  insured: z.object({ name: z.string().nullable(), address: z.string().nullable() }),
  producer: z.object({ name: z.string().nullable() }),
  policies: z.array(ExtractedPolicySchema),
  certificate_holder: z.object({ name: z.string().nullable(), address: z.string().nullable() }),
  overall_confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});
export type InsuranceExtraction = z.infer<typeof InsuranceExtractionSchema>;

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

export function normalizePolicyType(raw: string | null | undefined): PolicyType | null {
  if (!raw) return null;
  const exact = PolicyTypeSchema.safeParse(raw);
  if (exact.success) return exact.data;

  const key = raw.trim().toLowerCase();
  return POLICY_TYPE_SYNONYMS[key] ?? null;
}

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
