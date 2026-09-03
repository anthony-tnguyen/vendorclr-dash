/**
 * Shared by every DocumentExtractor implementation - the Claude-backed one
 * (documentExtraction.ts) and the Cloudflare Worker-backed one
 * (insuranceExtractionWorker.ts) - so "how confident is confident enough to
 * skip human review" is decided in exactly one place regardless of which
 * backend actually produced the extraction. Split out from
 * documentExtraction.ts specifically to avoid a circular import: that file
 * imports createWorkerExtractor() from insuranceExtractionWorker.ts, so
 * insuranceExtractionWorker.ts cannot import back from it.
 */

/**
 * Below this confidence, a technically-valid extraction is still routed to
 * `needs_review` rather than `processed`. `processed` does not mean
 * "compliant" - see the migration comment on vendor_documents - but it does
 * mean "trustworthy enough that the compliance engine could reasonably act
 * on it without a human looking first." A hedge below this line should not
 * carry that implication, no matter which backend produced it.
 */
export const CONFIDENCE_NEEDS_REVIEW_BELOW = 0.6;

export function statusForConfidence(confidence: number): "processed" | "needs_review" {
  return confidence >= CONFIDENCE_NEEDS_REVIEW_BELOW ? "processed" : "needs_review";
}
