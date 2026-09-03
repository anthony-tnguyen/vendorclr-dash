import { statusForConfidence } from "./extractionConfidence";
import { validateExtraction } from "./insuranceExtractionSchema";
import type {
  DocumentExtractor,
  ExtractDocumentInput,
  ExtractDocumentResult,
} from "./documentExtraction";

/**
 * DocumentExtractor backed by a separately-deployed Cloudflare Worker that
 * parses a certificate of insurance into JSON, used in place of calling
 * Claude directly (createAnthropicExtractor() in documentExtraction.ts).
 * getDocumentExtractor() selects this whenever COI_WORKER_URL and
 * COI_WORKER_API_KEY are both set, and falls back to the Claude path
 * otherwise - the same "gracefully degrade, never fail the request over
 * missing config" shape every provider in this project follows, and a
 * useful safety net if the worker is ever unreachable in an environment
 * where ANTHROPIC_API_KEY still is configured.
 *
 * IMPORTANT - wire contract not yet confirmed against a live call:
 *
 *   Request:  POST <COI_WORKER_URL>
 *             Authorization: Bearer <COI_WORKER_API_KEY>
 *             multipart/form-data - the file under field name "file", plus
 *             "mimeType" alongside it for convenience.
 *
 *   Response: 200 with a JSON body. The extraction may be at the top level
 *             or wrapped under a "data" or "result" key - unwrapEnvelope()
 *             below tries all three. Confirm the real shape against the
 *             worker (or share a sample response) and adjust
 *             unwrapEnvelope()/buildFormData() if either assumption is
 *             wrong - this was written from a description of the worker,
 *             not a live response.
 *
 * Once unwrapped, the response is run through validateExtraction() - the
 * exact normalization (policy-type synonym mapping) and zod validation
 * Claude's output goes through - so a worker response that is *almost*
 * right still comes through cleanly, and one that's genuinely malformed
 * routes to needs_review with a real validation error rather than a thrown
 * exception reaching the vendor mid-upload.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tries the raw body first - matches "the extraction object directly at the
 * top level" - then the two most common envelope shapes, in case the worker
 * wraps its result under a key instead. `"policies" in body` is the signal
 * that `body` itself is already the extraction, since that field name is
 * unique to InsuranceExtraction and not a generic envelope key.
 */
function unwrapEnvelope(body: unknown): unknown {
  if (!isRecord(body)) return body;
  if ("policies" in body) return body;
  if (isRecord(body["data"])) return body["data"];
  if (isRecord(body["result"])) return body["result"];
  return body;
}

function buildFormData(input: ExtractDocumentInput): FormData {
  const form = new FormData();
  const extension = input.mimeType.split("/")[1] ?? "pdf";
  const blob = new Blob([input.fileBytes], { type: input.mimeType });
  form.set("file", blob, `certificate.${extension}`);
  form.set("mimeType", input.mimeType);
  return form;
}

export function createWorkerExtractor(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): DocumentExtractor {
  return {
    async extract(input): Promise<ExtractDocumentResult> {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: buildFormData(input),
        });
      } catch (error) {
        return {
          status: "failed",
          data: null,
          confidence: null,
          error:
            error instanceof Error ? error.message : "Unknown error calling the extraction worker",
        };
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        return {
          status: "failed",
          data: null,
          confidence: null,
          error: `Extraction worker responded ${response.status}${
            bodyText ? `: ${bodyText.slice(0, 500)}` : ""
          }`,
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        return {
          status: "failed",
          data: null,
          confidence: null,
          error: `Extraction worker response was not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      const parsed = validateExtraction(unwrapEnvelope(body));
      if (!parsed.success || !parsed.data) {
        return {
          status: "needs_review",
          data: null,
          confidence: null,
          error: parsed.error ?? "Extraction worker result failed validation.",
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
