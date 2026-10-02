/**
 * Candidate B: structured outputs instead of "respond with ONLY JSON" + parse.
 *
 * This trials the robustness lever, not a wording lever. Production asks the
 * model for raw JSON in the prompt, then strips a possible code fence,
 * JSON.parse()s, and zod-validates - and any failure in that envelope dumps
 * the document to needs_review with null data (see parseExtractionResponse()).
 * Structured outputs move the schema guarantee server-side: the API constrains
 * the response to the schema, so that "valid extraction, malformed envelope"
 * failure class largely disappears.
 *
 * To trial it: copy this file to `candidate.ts` (only ONE candidate.ts is
 * active at a time), then run `bun run eval:coi`. Compare the headline number
 * AND the per-case ERROR lines against the baseline - the win here shows up as
 * fewer "needs_review (validation)" cases, not necessarily higher field
 * accuracy. If it wins, port the change into all three production copies.
 *
 * ---------------------------------------------------------------------------
 * ONE thing to verify for your SDK build (@anthropic-ai/sdk@0.122.0)
 * ---------------------------------------------------------------------------
 * The `zodOutputFormat` helper import below is the canonical path in current
 * SDKs, and documentExtraction.ts's own comment confirms this SDK version
 * ships it. If the import errors on your build, the only change needed is to
 * replace the `format:` value with a hand-written JSON Schema object:
 *   output_config: { effort: EFFORT, format: { type: "json_schema",
 *     name: "insurance_extraction", schema: <JSON Schema for the shape> } }
 * Everything else in this file stays the same. Nothing in production changes
 * until you port a winning result across by hand.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type {
  DocumentExtractor,
  ExtractDocumentInput,
  ExtractDocumentResult,
} from "../../src/workflows/documentExtraction";
import {
  InsuranceExtractionSchema,
  parseExtractionResponse,
} from "../../src/workflows/insuranceExtractionSchema";

// ---- KNOBS ---------------------------------------------------------------
const MODEL = "claude-opus-5";
const EFFORT: "low" | "medium" | "high" | "xhigh" | "max" = "high";
const CONFIDENCE_NEEDS_REVIEW_BELOW = 0.6;

// No "respond with ONLY JSON / no fencing" lines - the schema is enforced by
// the API now, so the prompt only has to carry the extraction RULES. Keep the
// domain rules that actually improve the reading; drop the format plumbing.
const SYSTEM_PROMPT = `You extract structured data from certificates of insurance (typically ACORD 25 forms) for a construction vendor-compliance product.

Rules:
- Extract every policy listed (General Liability, Workers Compensation, Auto, Umbrella, Professional Liability, Pollution Liability, Builders Risk, etc.) as a separate policy entry - a single certificate commonly lists several.
- Additional-insured, waiver-of-subrogation, and primary-noncontributory status are usually shown by a checkbox tied to an attached endorsement form (e.g. CG 20 10, CG 20 37, CG 24 04). If you cannot see an endorsement page, or the checkbox is ambiguous, use null for that field and say so in the notes rather than inferring from the checkbox alone.
- Additional-insured coverage is often split across "ongoing operations" (commonly CG 20 10) and "completed operations" (commonly CG 20 37). Report each independently when the certificate distinguishes them; still set the overall additional_insured field to your best single read. If only one combined checkbox is shown, leave the two split fields null.
- cancellation_notice_provided is whether the certificate shows the required advance-cancellation-notice language; cancellation_notice_days is the stated notice period only if a specific number is legible.
- employers_liability applies only to a Workers Compensation policy line (null for every other type) - its separate Part Two limits (each accident / disease-each-employee / disease-policy-limit).
- follows_form is specific to an Umbrella/Excess line: does the certificate state it follows form over the scheduled underlying policies. Null otherwise.
- endorsement_forms lists specific form numbers you can actually read (e.g. "CG 20 10 07 04"). Null if the certificate gives no basis to name any (the common case); an empty array only if you positively confirmed none are named.
- Use null for anything you cannot read confidently. Do not guess. Dates must be ISO (yyyy-mm-dd) or null.
- overall_confidence is your own 0.0-1.0 assessment of the whole extraction; it routes to automatic processing vs human review, so do not inflate it.`;
// --------------------------------------------------------------------------

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildUserContent(input: ExtractDocumentInput): Array<Anthropic.Messages.ContentBlockParam> {
  const data = toBase64(input.fileBytes);
  const documentBlock: Anthropic.Messages.ContentBlockParam =
    input.mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : {
          type: "image",
          source: { type: "base64", media_type: input.mimeType as "image/jpeg" | "image/png", data },
        };
  return [
    documentBlock,
    { type: "text", text: "Extract this certificate of insurance into the required schema." },
  ];
}

const candidate: DocumentExtractor = {
  async extract(input): Promise<ExtractDocumentResult> {
    const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
    if (!apiKey) {
      return { status: "not_configured", data: null, confidence: null, error: "ANTHROPIC_API_KEY unset" };
    }
    const client = new Anthropic({ apiKey });

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        output_config: {
          effort: EFFORT,
          // Server-enforced schema, built from the SAME zod schema production
          // validates against - no second schema to keep in sync.
          format: zodOutputFormat(InsuranceExtractionSchema, "insurance_extraction"),
        },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(input) }],
      });
    } catch (error) {
      return {
        status: "failed",
        data: null,
        confidence: null,
        error: error instanceof Error ? error.message : "Unknown error calling the extraction model",
      };
    }

    if (response.stop_reason === "refusal") {
      return { status: "failed", data: null, confidence: null, error: "The model declined to process this document." };
    }

    const text = response.content.find((block) => block.type === "text")?.text;
    if (!text) {
      return { status: "failed", data: null, confidence: null, error: "No text in the model response." };
    }

    // Still run the production parse/normalize/validate path as defense in
    // depth and to apply the policy-type synonym normalizer. With structured
    // outputs this should now effectively never fail - which is the point.
    const parsed = parseExtractionResponse(text);
    if (!parsed.success || !parsed.data) {
      return { status: "needs_review", data: null, confidence: null, error: parsed.error };
    }

    return {
      status: parsed.data.overall_confidence >= CONFIDENCE_NEEDS_REVIEW_BELOW ? "processed" : "needs_review",
      data: parsed.data,
      confidence: parsed.data.overall_confidence,
      error: null,
    };
  },
};

export default candidate;
