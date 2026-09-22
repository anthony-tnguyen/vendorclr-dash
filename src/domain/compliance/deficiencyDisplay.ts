import type { PolicyKind } from "@/domain/construction/types";
import type { PolicyType } from "@/data/dbTypeAliases";

/**
 * Plain-language rendering of a compliance deficiency for the contractor-facing
 * deficiency UI. Pure functions only - the same deficiency row always renders
 * the same way, and nothing here touches the database or the network.
 *
 * Vocabulary rule: these labels are what a contractor reads. "Open" becomes
 * "Needs correction", jsonb `expected`/`observed` become "Required" /
 * "Submitted" values, and the escalation clock's 3/7/14-day thresholds get
 * human phrasing. Internal names (requirement keys, policy types) are shown
 * only as a secondary detail line, never as the headline.
 */

/** Mirrors ComplianceDeficiencyRow.status (dbTypeAliases.ts). */
export type DeficiencyStatus = "open" | "resolved" | "waived";

export const DEFICIENCY_STATUS_LABELS: Record<DeficiencyStatus, string> = {
  open: "Needs correction",
  resolved: "Resolved",
  waived: "Waived — exception",
};

/** escalation_level smallint 0-3 (20260917001300_compliance_case_escalation.sql). */
export const ESCALATION_LEVEL_LABELS: Record<number, string> = {
  0: "No reminder sent yet",
  1: "3-day reminder sent",
  2: "7-day reminder sent",
  3: "14-day reminder sent",
};

export function escalationLabel(level: number): string {
  return ESCALATION_LEVEL_LABELS[level] ?? `Escalation level ${level}`;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function policyTypeLabel(policyType: string | null): string {
  if (!policyType) return "Coverage";
  return policyType
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Headline for the requirement a deficiency is about, e.g. "General Liability — Each Occurrence". */
export function requirementHeadline(input: {
  requirementKey: string;
  kind: PolicyKind | null;
  policyType: string | null;
  expected: Record<string, unknown>;
}): string {
  const label = policyTypeLabel(input.policyType);
  const field =
    typeof input.expected["endorsementField"] === "string"
      ? (input.expected["endorsementField"] as string)
          .split("_")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ")
      : null;
  if (input.kind === "endorsement" && field) return `${label} — ${field}`;
  if (input.kind === "document") {
    const documentKind =
      typeof input.expected["documentKind"] === "string"
        ? (input.expected["documentKind"] as string)
        : null;
    return documentKind
      ? documentKind
          .split("_")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ")
      : label;
  }
  return label;
}

export interface RequiredSubmitted {
  required: string;
  submitted: string;
}

/**
 * Required vs submitted values, readable first, raw second. A missing or
 * unreadable observation always says so in words ("Not shown on the
 * certificate") rather than rendering an empty cell - an unknown state is a
 * finding, not a blank.
 */
export function requiredVsSubmitted(input: {
  kind: PolicyKind | null;
  policyType?: string | null;
  expected: Record<string, unknown>;
  observed: Record<string, unknown> | null;
}): RequiredSubmitted {
  const { kind, expected, observed } = input;

  switch (kind) {
    case "limit": {
      const required =
        typeof expected["amount"] === "number"
          ? formatCurrency(expected["amount"])
          : "Amount not set";
      const submitted =
        observed && typeof observed["amount"] === "number"
          ? formatCurrency(observed["amount"])
          : "Not shown on the certificate";
      return { required, submitted };
    }

    case "endorsement": {
      const field =
        typeof expected["endorsementField"] === "string"
          ? (expected["endorsementField"] as string)
          : null;
      const required = field
        ? field
            .split("_")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ")
        : "Endorsement required";
      const observedValue = field && observed ? observed[field] : undefined;
      const submitted =
        observedValue === true
          ? "Shown on the certificate"
          : observedValue === false
            ? "Not shown on the certificate"
            : "Not shown on the certificate";
      return { required, submitted };
    }

    case "document": {
      const documentKind =
        typeof expected["documentKind"] === "string"
          ? (expected["documentKind"] as string)
              .split("_")
              .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
              .join(" ")
          : "document";
      return {
        required: documentKind,
        submitted: observed ? "Present" : "Missing",
      };
    }

    case "certificate_holder": {
      const required =
        typeof expected["name"] === "string"
          ? (expected["name"] as string)
          : "Certificate holder not set";
      const submitted =
        observed && typeof observed["name"] === "string"
          ? (observed["name"] as string)
          : "Not shown on the certificate";
      return { required, submitted };
    }

    default:
      return { required: "See requirement", submitted: "Not evaluated" };
  }
}
