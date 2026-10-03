import { describe, expect, it } from "vitest";
import {
  isEligibleScannerFeedback,
  type ScannerFeedbackRow,
} from "../../scripts/capture-scanner-feedback";

const validExtraction = {
  document_type: "ACORD_25",
  insured: { name: "Acme", address: null },
  producer: { name: null },
  policies: [],
  certificate_holder: { name: null, address: null },
  overall_confidence: 1,
  notes: null,
};

function row(overrides: Partial<ScannerFeedbackRow> = {}): ScannerFeedbackRow {
  return {
    id: crypto.randomUUID(),
    parser_run_id: crypto.randomUUID(),
    corrected_extraction: validExtraction,
    retained_object_path: "feedback/coi.pdf",
    retention_consent: true,
    verified_status: "verified",
    reviewed_at: new Date().toISOString(),
    parser_metadata: {},
    ...overrides,
  };
}

describe("scanner feedback golden-case eligibility", () => {
  it("requires verification, consent, a retained file, review timestamp, and schema-valid truth", () => {
    expect(isEligibleScannerFeedback(row())).toBe(true);
    expect(isEligibleScannerFeedback(row({ verified_status: "pending" }))).toBe(false);
    expect(isEligibleScannerFeedback(row({ retention_consent: false }))).toBe(false);
    expect(isEligibleScannerFeedback(row({ retained_object_path: null }))).toBe(false);
    expect(isEligibleScannerFeedback(row({ corrected_extraction: { invalid: true } }))).toBe(false);
  });
});
