import { describe, expect, it } from "vitest";

import { generateCorrectionInstruction } from "@/domain/compliance/cases";

/**
 * Task 10a - generateCorrectionInstruction() (src/domain/compliance/cases.ts).
 * Pure string templating off a deficiency's structured expected/observed
 * jsonb, one case per requirement `kind` (mirroring evaluatePackage.ts's
 * four evaluateX() functions), plus the null/unknown-observed cases every
 * kind must handle without crashing - "do not ask an LLM to decide
 * compliance" means there is no fallback except a deterministic template.
 */

describe("generateCorrectionInstruction()", () => {
  it("templates a limit deficiency with both expected and observed amounts", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "gl_each_occ",
      kind: "limit",
      policyType: "general_liability",
      expected: { required: true, policyType: "general_liability", amount: 2000000 },
      observed: { amount: 1000000 },
    });
    expect(text).toContain("$2,000,000");
    expect(text).toContain("general liability");
    expect(text).toContain("$1,000,000");
  });

  it("templates a limit deficiency with no observed amount at all (null observed)", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "gl_each_occ",
      kind: "limit",
      policyType: "general_liability",
      expected: { required: true, policyType: "general_liability", amount: 2000000 },
      observed: null,
    });
    expect(text).toContain("$2,000,000");
    expect(text).toContain("not shown on the certificate");
  });

  it("templates an endorsement deficiency that is explicitly false", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "ai_endorsement",
      kind: "endorsement",
      policyType: "general_liability",
      expected: {
        required: true,
        policyType: "general_liability",
        endorsementField: "additional_insured",
      },
      observed: { additional_insured: false },
    });
    expect(text).toContain("additional insured");
    expect(text).toContain("not present on the certificate");
  });

  it("templates an endorsement deficiency with unknown/null observed", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "ai_endorsement",
      kind: "endorsement",
      policyType: "general_liability",
      expected: {
        required: true,
        policyType: "general_liability",
        endorsementField: "additional_insured",
      },
      observed: null,
    });
    expect(text).toContain("additional insured");
    expect(text).toContain("not shown on the certificate");
  });

  it("templates a missing document deficiency", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "coi_doc",
      kind: "document",
      policyType: null,
      expected: { required: true, documentKind: "certificate_of_insurance" },
      observed: null,
    });
    expect(text.toLowerCase()).toContain("certificate of insurance");
    expect(text.toLowerCase()).toContain("upload");
  });

  it("templates a certificate_holder mismatch deficiency", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "cert_holder",
      kind: "certificate_holder",
      policyType: null,
      expected: { required: true, name: "Ridgeline GC LLC", address: "1 Main St" },
      observed: { name: "Ridgeline General Contracting", address: "1 Main St" },
    });
    expect(text).toContain("Ridgeline GC LLC");
    expect(text).toContain("Ridgeline General Contracting");
  });

  it("templates a certificate_holder deficiency with no project certificate holder on file", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "cert_holder",
      kind: "certificate_holder",
      policyType: null,
      expected: { required: true, name: "", address: "" },
      observed: null,
    });
    expect(text.toLowerCase()).toContain("certificate holder");
  });

  it("falls back to a generic instruction for a null/unrecognized kind rather than crashing", () => {
    const text = generateCorrectionInstruction({
      requirementKey: "unknown_kind",
      kind: null,
      policyType: null,
      expected: {},
      observed: null,
    });
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});
