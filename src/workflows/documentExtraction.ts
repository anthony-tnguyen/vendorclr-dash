import Anthropic from "@anthropic-ai/sdk";

import { statusForConfidence } from "./extractionConfidence";
import { createWorkerExtractor } from "./insuranceExtractionWorker";
import {
  INSURANCE_EXTRACTION_JSON_SHAPE,
  parseExtractionResponse,
  type InsuranceExtraction,
} from "./insuranceExtractionSchema";

/**
 * Document -> structured JSON, server-side only. Same pluggable-provider
 * shape as emailSender.ts, now three deep instead of two:
 *
 *   1. A Cloudflare Worker-backed implementation (createWorkerExtractor(),
 *      insuranceExtractionWorker.ts) when COI_WORKER_URL and
 *      COI_WORKER_API_KEY are both set - the primary path once configured.
 *   2. A real Anthropic-backed implementation (createAnthropicExtractor()
 *      below) when ANTHROPIC_API_KEY is set but the worker isn't -
 *      previously the only real implementation, kept as a fallback so an
 *      environment mid-migration to the worker (or one where the worker is
 *      temporarily unreachable) doesn't regress all the way to unprocessed
 *      uploads.
 *   3. A stub that returns "not_configured" rather than throwing when
 *      neither is set, so a document still gets safely stored (Phase 1's
 *      upload path) even when extraction cannot run at all.
 *
 * Every implementation shares the same DocumentExtractor interface and the
 * same InsuranceExtractionSchema validation (validateExtraction() in
 * insuranceExtractionSchema.ts) - callers (uploadDocumentForToken(),
 * reprocessDocument() in vendorUploadRequests.ts) never know or care which
 * one actually ran.
 *
 * Deliberately skips text-extraction-then-OCR-fallback for the Claude path.
 * Claude accepts the PDF or image directly as a document/image content
 * block and reads scanned and machine-generated certificates the same way -
 * there is no separate OCR step to fall back to, and no pdf-parse
 * dependency to keep working across a Cloudflare Workers deployment target.
 */

export type ExtractionStatus = "processed" | "needs_review" | "failed" | "not_configured";

export interface ExtractDocumentInput {
  fileBytes: ArrayBuffer;
  mimeType: string;
}

export interface ExtractDocumentResult {
  status: ExtractionStatus;
  data: InsuranceExtraction | null;
  /** Mirrors data.overall_confidence when present, for callers that don't want to unpack the JSON. */
  confidence: number | null;
  error: string | null;
}

export interface DocumentExtractor {
  extract(input: ExtractDocumentInput): Promise<ExtractDocumentResult>;
}

/** claude-opus-5 only, per this project's Anthropic API usage policy - never substituted for a cheaper model. */
const MODEL = "claude-opus-5";

const SYSTEM_PROMPT = `You extract structured data from certificates of insurance (typically ACORD 25 forms) for a construction vendor-compliance product.

Respond with ONLY a single JSON object matching this exact shape - no markdown fencing, no prose before or after:

${INSURANCE_EXTRACTION_JSON_SHAPE}

Rules:
- Extract every policy listed (General Liability, Workers Compensation, Auto, Umbrella, etc.) as a separate entry in "policies" - a single certificate commonly lists several.
- A certificate of insurance itself typically states it confers no rights on the certificate holder and does not amend the referenced policies. Additional-insured and waiver-of-subrogation status are usually shown by a checkbox tied to an attached endorsement form (e.g. CG 20 10, CG 20 37, CG 24 04). If you cannot see an endorsement page, or the checkbox is ambiguous, use null for that field and say so in "notes" rather than inferring an answer from the checkbox alone.
- Use null for anything you cannot read confidently - illegible handwriting, a cut-off scan, a field simply not present. Do not guess.
- Dates must be ISO format (yyyy-mm-dd) or null.
- "overall_confidence" is your own assessment of this whole extraction, 0.0-1.0. A clean, fully machine-generated certificate with every field legible should score high; a poor scan, handwriting, or missing pages should score lower - this number is what routes the result to automatic processing versus human review, so do not inflate it.`;

/**
 * Standard base64 (not base64url - the Anthropic API expects the former for
 * document/image `data`). Deliberately avoids `Buffer`, which is a Node-ism
 * not guaranteed available on the Cloudflare Workers target this project
 * builds for (nitro/vite.config.ts) - same reasoning as uploadTokens.ts.
 */
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

// This SDK version supports native structured outputs
// (output_config.format + the zodOutputFormat() helper), which would let the
// API itself guarantee schema-valid JSON instead of prompt-instructing for it
// and validating after the fact. Left as prompt + parseExtractionResponse()
// for now since that path is already built and tested; worth revisiting.
function createAnthropicExtractor(client: Anthropic): DocumentExtractor {
  return {
    async extract(input) {
      let response: Anthropic.Messages.Message;
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 8192,
          output_config: { effort: "medium" },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserContent(input) }],
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
    },
  };
}

function createStubExtractor(): DocumentExtractor {
  return {
    async extract() {
      console.warn(
        "[extraction stub] Neither COI_WORKER_URL/COI_WORKER_API_KEY nor ANTHROPIC_API_KEY is set - " +
          "the document was stored but not processed. Set one of those, or call reprocessDocument() " +
          "once it is set.",
      );
      return {
        status: "not_configured",
        data: null,
        confidence: null,
        error: "Document extraction is not configured (no worker or ANTHROPIC_API_KEY set).",
      };
    },
  };
}

export function getDocumentExtractor(
  clientFactory: (apiKey: string) => Anthropic = (apiKey) => new Anthropic({ apiKey }),
  fetchImpl: typeof fetch = fetch,
): DocumentExtractor {
  const workerUrl = process.env["COI_WORKER_URL"]?.trim();
  const workerApiKey = process.env["COI_WORKER_API_KEY"]?.trim();
  if (workerUrl && workerApiKey) {
    return createWorkerExtractor(workerUrl, workerApiKey, fetchImpl);
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  return apiKey ? createAnthropicExtractor(clientFactory(apiKey)) : createStubExtractor();
}
