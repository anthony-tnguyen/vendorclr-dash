import Anthropic from "@anthropic-ai/sdk";

import {
  CONFIDENCE_NEEDS_REVIEW_BELOW,
  EXTRACTION_MODEL,
  EXTRACTION_PROVIDER,
  SYSTEM_PROMPT,
  parseExtractionResponse,
  type InsuranceExtraction,
} from "./coiParserContract";

export { EXTRACTION_MODEL, EXTRACTION_PROVIDER } from "./coiParserContract";

/**
 * Document -> structured JSON, server-side only. Same pluggable-provider
 * shape as emailSender.ts: a real Anthropic-backed implementation when
 * ANTHROPIC_API_KEY is set, otherwise a stub that returns "not_configured"
 * rather than throwing, so a document still gets safely stored (Phase 1's
 * upload path) even when extraction cannot run.
 *
 * Deliberately skips text-extraction-then-OCR-fallback. Claude accepts the
 * PDF or image directly as a document/image content block and reads scanned
 * and machine-generated certificates the same way - there is no separate OCR
 * step to fall back to, and no pdf-parse dependency to keep working across a
 * Cloudflare Workers deployment target.
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

export function statusForConfidence(confidence: number): "processed" | "needs_review" {
  return confidence >= CONFIDENCE_NEEDS_REVIEW_BELOW ? "processed" : "needs_review";
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
          model: EXTRACTION_MODEL,
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
        "[extraction stub] ANTHROPIC_API_KEY is not set - the document was stored but not processed. " +
          "Set ANTHROPIC_API_KEY to enable extraction, or call reprocessDocument() once it is set.",
      );
      return {
        status: "not_configured",
        data: null,
        confidence: null,
        error: "Document extraction is not configured (ANTHROPIC_API_KEY unset).",
      };
    },
  };
}

export function getDocumentExtractor(
  clientFactory: (apiKey: string) => Anthropic = (apiKey) => new Anthropic({ apiKey }),
): DocumentExtractor {
  const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
  return apiKey ? createAnthropicExtractor(clientFactory(apiKey)) : createStubExtractor();
}
