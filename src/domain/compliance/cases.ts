import type { DocumentKind, PolicyType } from "@/data/dbTypeAliases";
import type { PolicyKind } from "@/domain/construction/types";

/**
 * Task 10a - the durable half of the correction loop. evaluatePackage()
 * (Task 9b, src/domain/compliance/evaluatePackage.ts) produces an
 * EvaluationResult but never persists it; this module is the TypeScript
 * mirror of what apply_evaluation_result()/approve_compliance_exception()
 * (supabase/migrations/20260917001200_compliance_cases.sql) persist and
 * read back, plus the one pure function that turns a structured deficiency
 * into a plain-language correction instruction.
 *
 * Deliberately NOT here: any function that lets a caller set a deficiency to
 * 'resolved' or 'waived' directly. The plan is explicit - "Never add a
 * generic 'mark compliant' action" - and the only two ways a deficiency ever
 * leaves 'open' in this schema are a real re-evaluation
 * (apply_evaluation_result(), driven by evaluatePackage()'s own evidence) or
 * a real approved exception (approve_compliance_exception(), below). No
 * shortcut exists anywhere in this file, the repository that wraps it
 * (complianceCaseRepository.ts), or the migration itself.
 */

/** Mirrors compliance_deficiencies.status's CHECK constraint. */
export type DeficiencyStatus = "open" | "resolved" | "waived";

/**
 * Mirrors approve_compliance_exception()'s parameters, which in turn
 * implement the plan's own ComplianceExceptionInput sketch - widened with
 * remainingRiskAcknowledged, which the plan's checklist explicitly requires
 * ("remaining-risk acknowledgement") even though the plan's own TS sketch
 * for this type omitted it. See the migration's approve_compliance_exception()
 * docblock for the fuller reasoning on why that omission is treated as an
 * earlier-sketch gap, not a license to drop the requirement.
 */
export interface ComplianceExceptionInput {
  deficiencyId: string;
  reason: string;
  effectiveOn: string;
  expiresOn: string;
  supportingDocumentId?: string;
  vendorVisible: boolean;
  remainingRiskAcknowledged: boolean;
}

/**
 * The fields generateCorrectionInstruction() needs - a subset of
 * compliance_deficiencies' own columns (ComplianceDeficiencyRow in
 * dbTypeAliases.ts), kept as its own loose interface here rather than
 * importing that row type directly so this pure function has no dependency
 * on the generated schema shape and stays trivially unit-testable.
 */
export interface CorrectionInstructionInput {
  requirementKey: string;
  kind: PolicyKind | null;
  policyType: PolicyType | null;
  expected: Record<string, unknown>;
  observed: Record<string, unknown> | null;
}

function formatCurrency(amount: unknown): string | null {
  return typeof amount === "number" ? `$${amount.toLocaleString()}` : null;
}

function policyLabel(policyType: PolicyType | null): string {
  if (!policyType) return "insurance";
  return policyType.replace(/_/g, " ");
}

function documentLabel(documentKind: unknown): string {
  return typeof documentKind === "string" && documentKind
    ? (documentKind as DocumentKind).replace(/_/g, " ")
    : "document";
}

/**
 * Generates a plain-language instruction directly from a deficiency's
 * structured expected/observed jsonb, entirely by deterministic string
 * templating - "Generate plain-language instructions from structured
 * rule/result templates; do not ask an LLM to decide compliance" (the
 * plan's own words). No network call, no model, no randomness: the same
 * input always produces the same string.
 *
 * Templates per `kind`, mirroring the four evaluateX() functions in
 * evaluatePackage.ts and the `expected` shape each one produces. `observed`
 * is always treated as possibly null/absent - a requirement can be
 * deficient (missing evidence entirely) or unknown (evidence present but
 * unreadable), and both must produce a sensible instruction rather than
 * crash on a null field.
 */
export function generateCorrectionInstruction(deficiency: CorrectionInstructionInput): string {
  const { kind, expected, observed } = deficiency;

  switch (kind) {
    case "limit": {
      const requiredAmount = formatCurrency(expected["amount"]);
      const label = policyLabel(deficiency.policyType);
      const observedAmount = observed ? formatCurrency(observed["amount"]) : null;
      const requirementText = requiredAmount
        ? `at least ${requiredAmount} ${label} coverage`
        : `${label} coverage meeting the required limit`;
      const observedText = observedAmount
        ? `currently on file: ${observedAmount}`
        : "not shown on the certificate";
      return `Upload a certificate of insurance showing ${requirementText} (${observedText}).`;
    }

    case "endorsement": {
      const endorsementField =
        typeof expected["endorsementField"] === "string"
          ? (expected["endorsementField"] as string).replace(/_/g, " ")
          : "the required endorsement";
      const label = policyLabel(deficiency.policyType);
      const observedValue =
        observed && typeof expected["endorsementField"] === "string"
          ? observed[expected["endorsementField"] as string]
          : undefined;
      const observedText =
        observedValue === false
          ? "currently shown as not present on the certificate"
          : "not shown on the certificate";
      return `Request an updated ${label} certificate that includes ${endorsementField} (${observedText}).`;
    }

    case "document": {
      const label = documentLabel(expected["documentKind"]);
      return `Upload a usable ${label} - none was found in this submission.`;
    }

    case "certificate_holder": {
      const expectedName = typeof expected["name"] === "string" ? expected["name"] : null;
      const observedName =
        observed && typeof observed["name"] === "string" ? (observed["name"] as string) : null;
      if (!expectedName) {
        return "Add a certificate holder to the project so the certificate can be checked against it.";
      }
      const observedText = observedName
        ? `certificate currently shows "${observedName}"`
        : "not shown on the certificate";
      return `Request a corrected certificate listing the certificate holder as "${expectedName}" (${observedText}).`;
    }

    case null:
    default:
      return "Review this requirement and resubmit the corrected document or endorsement.";
  }
}
