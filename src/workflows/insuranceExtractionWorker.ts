import { normalizePolicyType, validateExtraction } from "./insuranceExtractionSchema";
import type {
  DocumentExtractor,
  ExtractDocumentInput,
  ExtractDocumentResult,
} from "./documentExtraction";

/**
 * DocumentExtractor backed by the user's separately-deployed Cloudflare
 * Worker ("vendor-clear-parser") - confirmed against its actual source
 * (read directly from the Cloudflare dashboard; it has never lived in this
 * repo's git history) rather than assumed. Selected by getDocumentExtractor()
 * whenever COI_WORKER_URL and COI_WORKER_API_KEY are both set, for PDF
 * uploads only - see the PDF-only restriction below.
 *
 * CONFIRMED wire contract:
 *
 *   Request:  POST <COI_WORKER_URL>
 *             multipart/form-data, the file under field name "pdfData"
 *             (NOT "file" - the worker does `formData.get('pdfData')`).
 *             No Authorization header is checked by the worker at all right
 *             now - see the docblock on getDocumentExtractor() in
 *             documentExtraction.ts. We still send one (harmless, ignored)
 *             so nothing has to change here once the worker adds a real
 *             check.
 *
 *   Response: 200 `{ success: true, version, named_insured, producer_agent,
 *             certificate_holder, compliance_status, max_coverage,
 *             missing_endorsements, policies: [{ coverage_type, carrier_name,
 *             policy_number, effective_date, expiration_date,
 *             limit_each_occurrence, additional_insured, subrogation_waived,
 *             status, days_until_expiration }] }`, or non-200
 *             `{ success: false, error: "..." }`. Nothing here matches
 *             InsuranceExtractionSchema's field names - mapWorkerResponse()
 *             below is a real translation layer, not a thin adapter.
 *
 * Three things the worker's own shape cannot give us, and how this file
 * compensates:
 *
 *   1. No confidence score of any kind - only its own compliance_status
 *      ("PASS"/"FAIL"), which is a *different question* (does this
 *      certificate satisfy generic requirements, computed by the worker
 *      in isolation) from what overall_confidence answers here (how
 *      trustworthy is this extraction itself). Since the worker never
 *      signals its own uncertainty, mapWorkerResponse() always sets
 *      overall_confidence to 0 - statusForConfidence() then always
 *      routes the result to needs_review, never "processed", regardless
 *      of how complete the extraction looks. A worker-sourced result is
 *      never trusted to skip human review.
 *   2. No general_aggregate limit - the worker's schema only ever
 *      extracts limit_each_occurrence. limits.general_aggregate is always
 *      null (genuinely "not determinable" here, not a guess), so a
 *      compliance_requirements row keyed on general_aggregate_limit
 *      correctly reads as "certificate shows no amount" rather than being
 *      silently skipped.
 *   3. compliance_status/max_coverage/missing_endorsements are the
 *      worker's OWN compliance judgment, computed with no knowledge of
 *      what this vendor already has on file (it only ever sees the one
 *      document). This project's actual compliance decision -
 *      matchExtractedPolicy()/computeComplianceItems() in
 *      complianceEngine.ts, which compares against the active policy and
 *      this company's own compliance_requirements - is authoritative;
 *      the worker's verdict is deliberately discarded, not merged in,
 *      to avoid two independently-computed and possibly-disagreeing
 *      answers to "is this compliant." missing_endorsements is folded
 *      into `notes` as informational context for a reviewer only.
 *
 * PDF-only: the worker hardcodes `mimeType: "application/pdf"` in its own
 * call to Vertex AI regardless of what was actually uploaded, so a JPG/PNG
 * certificate would be silently mislabeled. getDocumentExtractor() only
 * ever calls this extractor for input.mimeType === "application/pdf" and
 * routes anything else straight to the Claude fallback - see this file's
 * only export, createWorkerExtractor(), which assumes it is only ever
 * called with a PDF; that guard lives in the caller, not here, since a
 * DocumentExtractor has no business deciding routing for its own caller.
 */

interface WorkerPolicy {
  coverage_type?: unknown;
  carrier_name?: unknown;
  policy_number?: unknown;
  effective_date?: unknown;
  expiration_date?: unknown;
  limit_each_occurrence?: unknown;
  additional_insured?: unknown;
  subrogation_waived?: unknown;
}

interface WorkerSuccessResponse {
  success: true;
  named_insured?: unknown;
  producer_agent?: unknown;
  certificate_holder?: unknown;
  missing_endorsements?: unknown;
  policies?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** The worker's schema says "0 if none" for a limit it found nothing to report - treated as null (not determinable), never as a real $0 limit. */
function asLimit(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function mapWorkerPolicy(raw: unknown): Record<string, unknown> {
  const policy = (raw ?? {}) as WorkerPolicy;
  return {
    type: normalizePolicyType(asString(policy.coverage_type)),
    carrier: asString(policy.carrier_name),
    policy_number: asString(policy.policy_number),
    effective_date: asString(policy.effective_date),
    expiration_date: asString(policy.expiration_date),
    limits: {
      each_occurrence: asLimit(policy.limit_each_occurrence),
      general_aggregate: null,
    },
    additional_insured: asBoolean(policy.additional_insured),
    waiver_of_subrogation: asBoolean(policy.subrogation_waived),
  };
}

/**
 * Translates the worker's actual response shape into something
 * validateExtraction() can check against InsuranceExtractionSchema. Returns
 * `unknown` deliberately - the caller runs this through validateExtraction()
 * immediately, the same as every other extraction backend, so a future
 * worker change that breaks this mapping still fails safely (needs_review
 * with a real validation error) instead of throwing.
 */
function mapWorkerResponse(body: WorkerSuccessResponse): unknown {
  const policies = Array.isArray(body.policies) ? body.policies.map(mapWorkerPolicy) : [];
  const missingEndorsements = Array.isArray(body.missing_endorsements)
    ? body.missing_endorsements.filter((v): v is string => typeof v === "string")
    : [];

  return {
    document_type: "OTHER",
    insured: { name: asString(body.named_insured), address: null },
    producer: { name: asString(body.producer_agent) },
    policies,
    certificate_holder: { name: asString(body.certificate_holder), address: null },
    // Always 0 - see this file's docblock on why a worker-sourced extraction
    // never claims a real confidence score.
    overall_confidence: 0,
    notes:
      "Parsed by the Cloudflare Worker extractor, which does not report its own " +
      "confidence - routed to review regardless of how complete this looks." +
      (missingEndorsements.length > 0
        ? ` Worker flagged missing endorsements: ${missingEndorsements.join(", ")}.`
        : ""),
  };
}

function buildFormData(input: ExtractDocumentInput): FormData {
  const form = new FormData();
  const blob = new Blob([input.fileBytes], { type: input.mimeType });
  form.set("pdfData", blob, "certificate.pdf");
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
          // Sent for when the worker's own auth check exists; ignored today - see this file's docblock.
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

      if (!response.ok || !isRecord(body) || body["success"] !== true) {
        const message =
          isRecord(body) && typeof body["error"] === "string"
            ? body["error"]
            : `Extraction worker responded ${response.status}`;
        return { status: "failed", data: null, confidence: null, error: message };
      }

      const parsed = validateExtraction(
        mapWorkerResponse(body as unknown as WorkerSuccessResponse),
      );
      if (!parsed.success || !parsed.data) {
        return {
          status: "needs_review",
          data: null,
          confidence: null,
          error: parsed.error ?? "Extraction worker result failed validation after mapping.",
        };
      }

      // Always needs_review - see this file's docblock. Not statusForConfidence():
      // that would work too (0 is always below CONFIDENCE_NEEDS_REVIEW_BELOW),
      // but naming the actual rule here is clearer than relying on a threshold
      // constant a reader would have to go check.
      return {
        status: "needs_review",
        data: parsed.data,
        confidence: parsed.data.overall_confidence,
        error: null,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
