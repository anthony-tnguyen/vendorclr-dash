import Anthropic from "npm:@anthropic-ai/sdk@0.122.0";
import {
  CONFIDENCE_NEEDS_REVIEW_BELOW,
  EXTRACTION_MODEL,
  SYSTEM_PROMPT,
  parseExtractionResponse,
  type InsuranceExtraction,
} from "./coiParserContract.ts";

export type ExtractionStatus = "processed" | "needs_review" | "failed";
export interface ExtractDocumentResult {
  status: ExtractionStatus;
  data: InsuranceExtraction | null;
  confidence: number | null;
  error: string | null;
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function extractDocument(
  client: Anthropic,
  fileBytes: ArrayBuffer,
  mimeType: string,
): Promise<ExtractDocumentResult> {
  const data = toBase64(fileBytes);
  const documentBlock: Anthropic.Messages.ContentBlockParam =
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : {
          type: "image",
          source: { type: "base64", media_type: mimeType as "image/jpeg" | "image/png", data },
        };
  try {
    const response = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 8192,
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            documentBlock,
            {
              type: "text",
              text: "Extract this certificate of insurance into the JSON shape described.",
            },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal")
      return {
        status: "failed",
        data: null,
        confidence: null,
        error: "The model declined to process this document.",
      };
    const text = response.content.find((block) => block.type === "text")?.text;
    if (!text)
      return {
        status: "failed",
        data: null,
        confidence: null,
        error: "No text in the model response.",
      };
    const parsed = parseExtractionResponse(text);
    if (!parsed.success || !parsed.data)
      return {
        status: "needs_review",
        data: null,
        confidence: null,
        error: parsed.error ?? "Extraction result failed validation.",
      };
    return {
      status:
        parsed.data.overall_confidence >= CONFIDENCE_NEEDS_REVIEW_BELOW
          ? "processed"
          : "needs_review",
      data: parsed.data,
      confidence: parsed.data.overall_confidence,
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      data: null,
      confidence: null,
      error: error instanceof Error ? error.message : "Unknown error calling the extraction model",
    };
  }
}
