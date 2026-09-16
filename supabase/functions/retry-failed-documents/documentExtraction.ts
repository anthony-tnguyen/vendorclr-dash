// Ported from src/workflows/documentExtraction.ts's Anthropic-calling half
// only (createAnthropicExtractor + its helpers) - this function runs in
// Supabase's Deno Edge Runtime, a separate deployment target with no shared
// build step across that boundary, same reasoning as
// insuranceExtractionSchema.ts alongside it. The pluggable-provider/stub
// split from the original does not apply here: retryFailedDocuments() only
// ever calls this when it already knows ANTHROPIC_API_KEY is set (checked
// once, up front, in index.ts - see its docblock for why skipping the whole
// run is more honest than a per-document not_configured result here).
import Anthropic from "npm:@anthropic-ai/sdk@0.122.0";

import {
  INSURANCE_EXTRACTION_JSON_SHAPE,
  parseExtractionResponse,
  type InsuranceExtraction,
} from "./insuranceExtractionSchema.ts";

export type ExtractionStatus = "processed" | "needs_review" | "failed";

export interface ExtractDocumentResult {
  status: ExtractionStatus;
  data: InsuranceExtraction | null;
  confidence: number | null;
  error: string | null;
}

/** claude-opus-5 only, per this project's Anthropic API usage policy - matches documentExtraction.ts exactly. */
const MODEL = "claude-opus-5";

/** Matches documentExtraction.ts's CONFIDENCE_NEEDS_REVIEW_BELOW exactly - keep the two in sync. */
const CONFIDENCE_NEEDS_REVIEW_BELOW = 0.6;

const SYSTEM_PROMPT = `You extract structured data from certificates of insurance (typically ACORD 25 forms) for a construction vendor-compliance product.

Respond with ONLY a single JSON object matching this exact shape - no markdown fencing, no prose before or after:

${INSURANCE_EXTRACTION_JSON_SHAPE}

Rules:
- Extract every policy listed (General Liability, Workers Compensation, Auto, Umbrella, Professional Liability, Pollution Liability, Builders Risk, etc.) as a separate entry in "policies" - a single certificate commonly lists several.
- A certificate of insurance itself typically states it confers no rights on the certificate holder and does not amend the referenced policies. Additional-insured, waiver-of-subrogation, and primary-noncontributory status are usually shown by a checkbox tied to an attached endorsement form (e.g. CG 20 10, CG 20 37, CG 24 04). If you cannot see an endorsement page, or the checkbox is ambiguous, use null for that field and say so in "notes" rather than inferring an answer from the checkbox alone.
- Additional-insured coverage is often split across two separate checkboxes/endorsements: "ongoing operations" (commonly CG 20 10) and "completed operations" (commonly CG 20 37). Report each independently in additional_insured_ongoing_operations/additional_insured_completed_operations when the certificate distinguishes them; still set the overall additional_insured field to your best single read of whether additional-insured status applies at all. If the certificate only shows one combined checkbox with no ongoing/completed split, leave the two split fields null rather than guessing which one it means.
- cancellation_notice_provided is whether the certificate shows the required advance-cancellation-notice language (most ACORD 25 forms carry this near the bottom, sometimes struck through or amended). cancellation_notice_days is the stated notice period in days if you can read a specific number - leave it null if the language is present but no specific day count is legible.
- employers_liability applies only to a Workers Compensation policy line (leave it null for every other coverage type) - it is that policy's separate "Part Two" limits (each accident / disease-each-employee / disease-policy-limit), distinct from the policy's own liability limits.
- follows_form is specific to an Umbrella/Excess policy line: does the certificate state the umbrella/excess policy follows form over (or otherwise provides evidence of excess coverage for) the scheduled underlying policies. Leave null for other coverage types or when not stated.
- endorsement_forms lists specific endorsement form numbers you can actually read as attached to or referenced by that policy line (e.g. "CG 20 10 07 04"). Use null if the certificate gives no basis to identify any forms by number (this is the common case), or an empty array only if you positively confirmed no endorsement forms are named.
- Use null for anything you cannot read confidently - illegible handwriting, a cut-off scan, a field simply not present. Do not guess.
- Dates must be ISO format (yyyy-mm-dd) or null.
- "overall_confidence" is your own assessment of this whole extraction, 0.0-1.0. A clean, fully machine-generated certificate with every field legible should score high; a poor scan, handwriting, or missing pages should score lower - this number is what routes the result to automatic processing versus human review, so do not inflate it.`;

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildUserContent(
  fileBytes: ArrayBuffer,
  mimeType: string,
): Array<Anthropic.Messages.ContentBlockParam> {
  const data = toBase64(fileBytes);

  const documentBlock: Anthropic.Messages.ContentBlockParam =
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : {
          type: "image",
          source: { type: "base64", media_type: mimeType as "image/jpeg" | "image/png", data },
        };

  return [
    documentBlock,
    { type: "text", text: "Extract this certificate of insurance into the JSON shape described." },
  ];
}

function statusForConfidence(confidence: number): "processed" | "needs_review" {
  return confidence >= CONFIDENCE_NEEDS_REVIEW_BELOW ? "processed" : "needs_review";
}

export async function extractDocument(
  client: Anthropic,
  fileBytes: ArrayBuffer,
  mimeType: string,
): Promise<ExtractDocumentResult> {
  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserContent(fileBytes, mimeType) }],
    });
  } catch (error) {
    return {
      status: "failed",
      data: null,
      confidence: null,
      error:
        error instanceof Anthropic.APIError
          ? `Anthropic API error (${error.status}): ${error.message}`
          : error instanceof Error
            ? error.message
            : "Unknown error calling the extraction model",
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
    return {
      status: "needs_review",
      data: null,
      confidence: null,
      error: parsed.error ?? "Extraction result failed validation.",
    };
  }

  return {
    status: statusForConfidence(parsed.data.overall_confidence),
    data: parsed.data,
    confidence: parsed.data.overall_confidence,
    error: null,
  };
}
