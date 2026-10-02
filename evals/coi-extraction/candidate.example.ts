/**
 * Candidate extractor template for hill-climbing against the golden set.
 *
 * Copy this file to `candidate.ts` (same directory) and edit the knobs below.
 * When `candidate.ts` exists, `scripts/eval-coi-extraction.ts` tests IT instead
 * of the production extractor, so you can trial a new prompt / effort / model
 * WITHOUT first editing the three byte-for-byte production copies. Once a
 * candidate beats the baseline, port the winning change into all three copies
 * (src/workflows/, supabase/functions/process-document-jobs/,
 * supabase/functions/retry-failed-documents/), bump EXTRACTION_SCHEMA_VERSION
 * if the shape/prompt changed, and delete candidate.ts.
 *
 * This is deliberately a near-copy of createAnthropicExtractor() in
 * src/workflows/documentExtraction.ts — keep it that close so the only thing
 * the eval measures is the knob you changed.
 */
import Anthropic from "@anthropic-ai/sdk";

import type {
  DocumentExtractor,
  ExtractDocumentInput,
  ExtractDocumentResult,
} from "../../src/workflows/documentExtraction";
import {
  INSURANCE_EXTRACTION_JSON_SHAPE,
  parseExtractionResponse,
} from "../../src/workflows/insuranceExtractionSchema";

// ---- KNOBS ---------------------------------------------------------------
const MODEL = "claude-opus-5";
// Baseline production is "medium". Try "high" first — it is the single biggest
// accuracy lever here for the careful visual reads (struck-through clauses,
// split endorsements, WC Part Two limits).
const EFFORT: "low" | "medium" | "high" | "xhigh" | "max" = "high";
const CONFIDENCE_NEEDS_REVIEW_BELOW = 0.6;

// Edit this to trial prompt wording. Starts identical to production.
const SYSTEM_PROMPT = `You extract structured data from certificates of insurance (typically ACORD 25 forms) for a construction vendor-compliance product.

Respond with ONLY a single JSON object matching this exact shape - no markdown fencing, no prose before or after:

${INSURANCE_EXTRACTION_JSON_SHAPE}

Rules:
- Extract every policy listed (General Liability, Workers Compensation, Auto, Umbrella, Professional Liability, Pollution Liability, Builders Risk, etc.) as a separate entry in "policies".
- Use null for anything you cannot read confidently. Do not guess.
- Dates must be ISO format (yyyy-mm-dd) or null.
- "overall_confidence" is your own assessment of this whole extraction, 0.0-1.0. Do not inflate it; this number routes to automatic processing vs human review.`;
// --------------------------------------------------------------------------

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildUserContent(
  input: ExtractDocumentInput,
): Array<Anthropic.Messages.ContentBlockParam> {
  const data = toBase64(input.fileBytes);
  const documentBlock: Anthropic.Messages.ContentBlockParam =
    input.mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: input.mimeType as "image/jpeg" | "image/png",
            data,
          },
        };
  return [
    documentBlock,
    { type: "text", text: "Extract this certificate of insurance into the JSON shape described." },
  ];
}

const candidate: DocumentExtractor = {
  async extract(input): Promise<ExtractDocumentResult> {
    const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
    if (!apiKey) {
      return {
        status: "not_configured",
        data: null,
        confidence: null,
        error: "ANTHROPIC_API_KEY unset",
      };
    }
    const client = new Anthropic({ apiKey });

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 8192,
        output_config: { effort: EFFORT },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(input) }],
      });
    } catch (error) {
      return {
        status: "failed",
        data: null,
        confidence: null,
        error:
          error instanceof Error ? error.message : "Unknown error calling the extraction model",
      };
    }

    if (response.stop_reason === "refusal") {
      return {
        status: "failed",
        data: null,
        confidence: null,
        error: "The model declined to process this document.",
      };
    }

    const text = response.content.find((block) => block.type === "text")?.text;
    if (!text) {
      return {
        status: "failed",
        data: null,
        confidence: null,
        error: "No text in the model response.",
      };
    }

    const parsed = parseExtractionResponse(text);
    if (!parsed.success || !parsed.data) {
      return { status: "needs_review", data: null, confidence: null, error: parsed.error };
    }

    return {
      status:
        parsed.data.overall_confidence >= CONFIDENCE_NEEDS_REVIEW_BELOW
          ? "processed"
          : "needs_review",
      data: parsed.data,
      confidence: parsed.data.overall_confidence,
      error: null,
    };
  },
};

export default candidate;
