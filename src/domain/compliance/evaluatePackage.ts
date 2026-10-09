import type { DocumentKind, PolicyType } from "@/data/dbTypeAliases";
import type { ExtractedPolicy, InsuranceExtraction } from "@/workflows/insuranceExtractionSchema";
import type { ResolvedRequirement } from "@/domain/construction/types";

/**
 * Task 9b - the package evaluator: turns a resolved requirement set (Task
 * 4's resolve_assignment_requirements(), widened in Task 9b to also carry
 * `configuration` - see supabase/migrations/20260917001100_resolved_requirement_configuration.sql)
 * plus a submission package's actual evidence into a per-requirement finding.
 *
 * Same pure-function/I/O-shell split this project already established in
 * src/workflows/complianceEngine.ts (matchExtractedPolicy()/
 * computeComplianceItems()): evaluateRequirementsAgainstEvidence() below is
 * pure, has no I/O, and is the unit-tested core
 * (src/tests/package-evaluation.test.ts); evaluatePackage() is the thin I/O
 * shell that reads the request-scoped tables and calls it.
 *
 * The plan's central requirement for this task: evaluate the whole PACKAGE
 * against the resolved assignment snapshot and the PROJECT's certificate
 * holder - never the vendor's company-global state. PackageEvidence is
 * deliberately scoped to one package's documents; certificateHolder is
 * passed in as a parameter sourced from projects.certificate_holder_name/
 * certificate_holder_address, never read from anywhere company-global inside
 * this module.
 *
 * Every field stays tri-state. A `null`/absent value on the evidence side
 * must produce `unknown`, never be silently treated as satisfying (or
 * failing) a requirement - this is the exact discipline the plan's
 * Definition of Done calls out by name for PNC/endorsement fields, and this
 * module applies it identically to `limit`'s null-handling.
 */

export type EvidenceState = "verified" | "deficient" | "unknown" | "not_applicable";

export interface EvaluationResult {
  assignmentId: string;
  documentPackageId: string;
  evaluatedAt: string;
  requirements: ResolvedRequirement[];
  findings: Array<{
    requirementKey: string;
    state: EvidenceState;
    expected: Record<string, unknown>;
    observed: Record<string, unknown> | null;
    evidenceDocumentIds: string[];
    explanation: string;
  }>;
}

export type Finding = EvaluationResult["findings"][number];

export interface PackageEvidenceDocument {
  id: string;
  /** package_documents.document_kind for this slot. */
  documentKind: DocumentKind;
  /** vendor_documents.processing_status. */
  processingStatus: string;
  /** vendor_documents.parsed_data - already the current-extraction cache per Task 9a. */
  parsedData: InsuranceExtraction | null;
}

export interface PackageEvidence {
  /**
   * Every vendor_documents row in this specific package - deliberately
   * package-scoped, never a company-wide vendor_policies read. A
   * resubmission (replaceDeficientDocument(), submissionPackages.ts) carries
   * forward prior documents' package_documents links into the new package
   * version, so "every document in this package" can legitimately span
   * several original uploads.
   */
  documents: PackageEvidenceDocument[];
}

export interface CertificateHolderOnFile {
  name: string;
  address: string;
}

/** Processing statuses that count as real, usable evidence - a failed/still-processing row is not evidence yet. */
const USABLE_PROCESSING_STATUSES = new Set(["processed", "needs_review"]);

/**
 * Loose trimmed-lowercase-equality comparison, the same rule already
 * established in src/features/vendors/VendorDetailPage.tsx's
 * looksLikeMismatch() - factored out here so the certificate_holder finding
 * below and any future caller share one implementation rather than a third
 * copy of the same string logic. Deliberately not a fuzzy-match library -
 * this project's established comparison is exact-after-normalization, not
 * approximate.
 */
export function namesLooselyMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function policiesMatchingType(
  documents: PackageEvidenceDocument[],
  policyType: PolicyType | null,
): Array<{ documentId: string; policy: ExtractedPolicy }> {
  const matches: Array<{ documentId: string; policy: ExtractedPolicy }> = [];
  for (const doc of documents) {
    if (!doc.parsedData) continue;
    for (const policy of doc.parsedData.policies) {
      if (policy.type !== null && policy.type === policyType) {
        matches.push({ documentId: doc.id, policy });
      }
    }
  }
  return matches;
}

function evaluateLimit(requirement: ResolvedRequirement, evidence: PackageEvidence): Finding {
  const limitField = requirement.configuration["limitField"];
  const expected: Record<string, unknown> = {
    required: requirement.required,
    policyType: requirement.policyType,
    limitField,
    amount: requirement.amount,
  };

  const matches = policiesMatchingType(evidence.documents, requirement.policyType);

  if (matches.length === 0) {
    return {
      requirementKey: requirement.key,
      state: "deficient",
      expected,
      observed: null,
      evidenceDocumentIds: [],
      explanation: `No ${requirement.policyType ?? "matching"} policy line was found in this submission.`,
    };
  }

  // Best (highest) value found across every matching policy line in the
  // package, recording every contributing document - a resubmission can
  // carry forward multiple documents that each speak to the same
  // requirement, and picking only the first one found would silently drop
  // evidence a reviewer would expect considered.
  let bestAmount: number | null = null;
  const contributingDocumentIds: string[] = [];
  for (const { documentId, policy } of matches) {
    const raw =
      typeof limitField === "string"
        ? (policy.limits as Record<string, number | null | undefined>)[limitField]
        : undefined;
    const amount = typeof raw === "number" ? raw : null;
    if (amount === null) continue;
    contributingDocumentIds.push(documentId);
    if (bestAmount === null || amount > bestAmount) bestAmount = amount;
  }

  if (bestAmount === null) {
    // Matching policy line(s) exist but none show a resolvable amount for
    // this specific field - this must never be silently treated as passing.
    // See the module docblock: the plan's Definition of Done treats this
    // exactly the same as the endorsement-null case below.
    return {
      requirementKey: requirement.key,
      state: "unknown",
      expected,
      observed: null,
      evidenceDocumentIds: matches.map((m) => m.documentId),
      explanation: `A ${requirement.policyType ?? "matching"} policy was found, but the certificate did not show a resolvable amount for ${typeof limitField === "string" ? limitField : "this limit field"}.`,
    };
  }

  const observed = { amount: bestAmount };
  const requiredAmount = requirement.amount;
  if (requiredAmount !== null && bestAmount < requiredAmount) {
    return {
      requirementKey: requirement.key,
      state: "deficient",
      expected,
      observed,
      evidenceDocumentIds: contributingDocumentIds,
      explanation: `Highest ${typeof limitField === "string" ? limitField : "limit"} found is $${bestAmount.toLocaleString()}, below the required $${requiredAmount.toLocaleString()}.`,
    };
  }

  return {
    requirementKey: requirement.key,
    state: "verified",
    expected,
    observed,
    evidenceDocumentIds: contributingDocumentIds,
    explanation: `Highest ${typeof limitField === "string" ? limitField : "limit"} found is $${bestAmount.toLocaleString()}, meeting the requirement.`,
  };
}

function evaluateEndorsement(requirement: ResolvedRequirement, evidence: PackageEvidence): Finding {
  const endorsementField = requirement.configuration["endorsementField"];
  const expected: Record<string, unknown> = {
    required: requirement.required,
    policyType: requirement.policyType,
    endorsementField,
  };

  const matches = policiesMatchingType(evidence.documents, requirement.policyType);

  if (matches.length === 0 || typeof endorsementField !== "string") {
    return {
      requirementKey: requirement.key,
      state: "unknown",
      expected,
      observed: null,
      evidenceDocumentIds: [],
      explanation: `No ${requirement.policyType ?? "matching"} policy line was found to check ${typeof endorsementField === "string" ? endorsementField : "this endorsement"} against.`,
    };
  }

  // true on ANY matching line wins as verified; else false on any wins as
  // deficient; else (every matching line is null) unknown. Null/absent must
  // never auto-clear - this is exactly the PNC/endorsement-unknowns
  // invariant the plan's Definition of Done calls out by name.
  let sawTrue: string | null = null;
  let sawFalse: string | null = null;
  const consideredDocumentIds: string[] = [];
  for (const { documentId, policy } of matches) {
    consideredDocumentIds.push(documentId);
    const value = (policy as unknown as Record<string, unknown>)[endorsementField];
    if (value === true && sawTrue === null) sawTrue = documentId;
    if (value === false && sawFalse === null) sawFalse = documentId;
  }

  const policyLabel = requirement.policyType ? `${requirement.policyType} ` : "";

  if (sawTrue !== null) {
    return {
      requirementKey: requirement.key,
      state: "verified",
      expected,
      observed: { [endorsementField]: true },
      evidenceDocumentIds: [sawTrue],
      explanation: `${endorsementField} confirmed true on at least one submitted ${policyLabel}certificate.`,
    };
  }

  if (sawFalse !== null) {
    return {
      requirementKey: requirement.key,
      state: "deficient",
      expected,
      observed: { [endorsementField]: false },
      evidenceDocumentIds: [sawFalse],
      explanation: `${endorsementField} explicitly not present on the submitted ${policyLabel}certificate.`,
    };
  }

  return {
    requirementKey: requirement.key,
    state: "unknown",
    expected,
    observed: null,
    evidenceDocumentIds: consideredDocumentIds,
    explanation: `${endorsementField} could not be determined from the submitted certificate(s) - never treated as satisfying the requirement.`,
  };
}

function evaluateDocument(requirement: ResolvedRequirement, evidence: PackageEvidence): Finding {
  const documentKind = requirement.configuration["documentKind"];
  const expected: Record<string, unknown> = {
    required: requirement.required,
    documentKind,
  };

  const found = evidence.documents.find(
    (doc) =>
      doc.documentKind === documentKind && USABLE_PROCESSING_STATUSES.has(doc.processingStatus),
  );

  if (!found) {
    return {
      requirementKey: requirement.key,
      state: "deficient",
      expected,
      observed: null,
      evidenceDocumentIds: [],
      explanation: `No usable ${typeof documentKind === "string" ? documentKind.replace(/_/g, " ") : "document"} was found in this submission.`,
    };
  }

  return {
    requirementKey: requirement.key,
    state: "verified",
    expected,
    observed: { documentKind: found.documentKind, documentId: found.id },
    evidenceDocumentIds: [found.id],
    explanation: `A usable ${found.documentKind.replace(/_/g, " ")} was found in this submission.`,
  };
}

function evaluateCertificateHolder(
  requirement: ResolvedRequirement,
  evidence: PackageEvidence,
  certificateHolder: CertificateHolderOnFile,
): Finding {
  const expected: Record<string, unknown> = {
    required: requirement.required,
    name: certificateHolder.name,
    address: certificateHolder.address,
  };

  if (!certificateHolder.name.trim()) {
    return {
      requirementKey: requirement.key,
      state: "unknown",
      expected,
      observed: null,
      evidenceDocumentIds: [],
      explanation: "The project has no certificate holder on file to compare against.",
    };
  }

  const withCapturedHolder = evidence.documents.filter(
    (doc) =>
      doc.parsedData?.certificate_holder.name && doc.parsedData.certificate_holder.name.trim(),
  );

  if (withCapturedHolder.length === 0) {
    return {
      requirementKey: requirement.key,
      state: "unknown",
      expected,
      observed: null,
      evidenceDocumentIds: [],
      explanation: "No submitted document captured a certificate holder name to compare.",
    };
  }

  const match = withCapturedHolder.find((doc) =>
    namesLooselyMatch(doc.parsedData!.certificate_holder.name!, certificateHolder.name),
  );

  if (match) {
    return {
      requirementKey: requirement.key,
      state: "verified",
      expected,
      observed: {
        name: match.parsedData!.certificate_holder.name,
        address: match.parsedData!.certificate_holder.address,
      },
      evidenceDocumentIds: [match.id],
      explanation: "Certificate holder on the submitted certificate matches the project's on file.",
    };
  }

  return {
    requirementKey: requirement.key,
    state: "deficient",
    expected,
    observed: {
      name: withCapturedHolder[0]!.parsedData!.certificate_holder.name,
      address: withCapturedHolder[0]!.parsedData!.certificate_holder.address,
    },
    evidenceDocumentIds: withCapturedHolder.map((d) => d.id),
    explanation:
      "Certificate holder on the submitted certificate(s) does not match the project's on file.",
  };
}

/**
 * Evaluates every resolved requirement against a package's evidence. Pure -
 * no I/O, no Date.now()/randomness - given the same requirements/evidence/
 * certificateHolder inputs, always produces byte-identical findings (the
 * caller stamps `evaluatedAt` itself, outside this function). See this
 * module's docblock for why that determinism, and the tri-state/never-auto-
 * clear discipline, both matter to the plan's Definition of Done.
 */
export function evaluateRequirementsAgainstEvidence(
  requirements: ResolvedRequirement[],
  evidence: PackageEvidence,
  certificateHolder: CertificateHolderOnFile,
): Finding[] {
  return requirements.map((requirement) => {
    // A requirement the resolver returns as not required (e.g. deselected for
    // this vendor via vendor_requirement_overrides) is never a deficiency: it
    // is reported not_applicable and apply_evaluation_result() skips it. Every
    // requirement_profile_rules row is written required=true, so this only ever
    // fires for an explicit false override, leaving existing behaviour intact.
    if (requirement.required === false) {
      return {
        requirementKey: requirement.key,
        state: "not_applicable",
        expected: { required: false },
        observed: null,
        evidenceDocumentIds: [],
        explanation: "This requirement is not required for this vendor, so it was not evaluated.",
      };
    }
    switch (requirement.kind) {
      case "limit":
        return evaluateLimit(requirement, evidence);
      case "endorsement":
        return evaluateEndorsement(requirement, evidence);
      case "document":
        return evaluateDocument(requirement, evidence);
      case "certificate_holder":
        return evaluateCertificateHolder(requirement, evidence, certificateHolder);
      default: {
        const exhaustive: never = requirement.kind;
        throw new Error(`Unhandled requirement kind: ${String(exhaustive)}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// evaluatePackage() - the I/O shell
// ---------------------------------------------------------------------------

async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

export interface EvaluatePackageInput {
  assignmentId: string;
  packageId: string;
}

/**
 * Reads everything evaluateRequirementsAgainstEvidence() needs via the
 * REQUEST-SCOPED client (an ordinary signed-in company member's own
 * session, not the service role) and wraps its result into a full
 * EvaluationResult. Deliberately does NOT call assertPlatformAdmin() /
 * escalate to the service role - unlike Task 9a's staff-only
 * saveExtractionEdit(), this is meant to be called by any signed-in company
 * member reviewing their own vendor's submission, and RLS on projects /
 * submission_packages / package_documents / vendor_documents (all
 * company-scoped SELECT policies - see 20260916000300_construction_core_expand.sql
 * and 20260917000300_submission_packages.sql) is the actual enforcement for
 * those direct reads. resolve_assignment_requirements() enforces cross-
 * tenant access itself (it is SECURITY DEFINER and does not inherit RLS -
 * see that function's own docblock), so the assignment id passed in here is
 * never trusted on faith either.
 */
export async function evaluatePackage(input: EvaluatePackageInput): Promise<EvaluationResult> {
  const supabase = await getRequestScopedClient();

  const { resolveAssignmentRequirements } =
    await import("@/data/repositories/requirementRepository");
  const requirements = await resolveAssignmentRequirements(input.assignmentId);

  const { data: assignment, error: assignmentError } = await supabase
    .from("project_vendor_assignments")
    .select("project_id")
    .eq("id", input.assignmentId)
    .maybeSingle();

  if (assignmentError || !assignment) {
    throw new Error("Could not resolve the assignment for this evaluation.");
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("certificate_holder_name, certificate_holder_address")
    .eq("id", assignment.project_id as string)
    .maybeSingle();

  if (projectError || !project) {
    throw new Error("Could not resolve the project for this evaluation.");
  }

  const certificateHolder: CertificateHolderOnFile = {
    name: (project as { certificate_holder_name: string | null }).certificate_holder_name ?? "",
    address:
      (project as { certificate_holder_address: string | null }).certificate_holder_address ?? "",
  };

  const { data: pkg, error: packageError } = await supabase
    .from("submission_packages")
    .select("id")
    .eq("id", input.packageId)
    .maybeSingle();

  if (packageError || !pkg) {
    throw new Error("Could not resolve the submission package for this evaluation.");
  }

  const { data: links, error: linksError } = await supabase
    .from("package_documents")
    .select("document_kind, vendor_documents(id, processing_status, parsed_data)")
    .eq("package_id", input.packageId);

  if (linksError) {
    throw new Error("Could not read this submission's documents.");
  }

  type LinkRow = {
    document_kind: string;
    vendor_documents: {
      id: string;
      processing_status: string;
      parsed_data: InsuranceExtraction | null;
    } | null;
  };

  const documents: PackageEvidenceDocument[] = ((links ?? []) as unknown as LinkRow[])
    .filter((link) => link.vendor_documents !== null)
    .map((link) => ({
      id: link.vendor_documents!.id,
      documentKind: link.document_kind as DocumentKind,
      processingStatus: link.vendor_documents!.processing_status,
      parsedData: link.vendor_documents!.parsed_data,
    }));

  const findings = evaluateRequirementsAgainstEvidence(
    requirements,
    { documents },
    certificateHolder,
  );

  return {
    assignmentId: input.assignmentId,
    documentPackageId: input.packageId,
    evaluatedAt: new Date().toISOString(),
    requirements,
    findings,
  };
}
