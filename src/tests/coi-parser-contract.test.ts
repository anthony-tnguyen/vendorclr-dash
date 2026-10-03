import { describe, expect, it } from "vitest";

import {
  PARSER_CONTRACT_FINGERPRINT,
  PARSER_METADATA,
  computeParserContractFingerprint,
  parseExtractionResponse,
} from "@/workflows/coiParserContract";

function validExtraction(policyType: string = "general_liability") {
  return {
    document_type: "ACORD_25",
    insured: { name: "Acme", address: null },
    producer: { name: "Broker" },
    policies: [{
      type: policyType,
      carrier: "Carrier",
      policy_number: "GL-1",
      effective_date: "2026-01-01",
      expiration_date: "2027-01-01",
      limits: { each_occurrence: 1_000_000, general_aggregate: 2_000_000 },
      additional_insured: true,
      waiver_of_subrogation: null,
      endorsement_forms: ["CG 20 10 07 04"],
    }],
    certificate_holder: { name: "Builder", address: null },
    overall_confidence: 0.9,
    notes: null,
  };
}

describe("canonical COI parser contract", () => {
  it("normalizes policy-type synonyms before strict validation", () => {
    const result = parseExtractionResponse(JSON.stringify(validExtraction("Commercial General Liability")));
    expect(result.success).toBe(true);
    expect(result.data?.policies[0]?.type).toBe("general_liability");
  });

  it.each(["not json", JSON.stringify({ policies: [] }), JSON.stringify({ ...validExtraction(), overall_confidence: 2 })])(
    "rejects malformed or incomplete output",
    (text) => expect(parseExtractionResponse(text).success).toBe(false),
  );

  it("keeps parser metadata bound to the semantic contract fingerprint", () => {
    expect(PARSER_CONTRACT_FINGERPRINT).toBe(computeParserContractFingerprint());
    expect(PARSER_METADATA.contractFingerprint).toBe(PARSER_CONTRACT_FINGERPRINT);
  });
});
