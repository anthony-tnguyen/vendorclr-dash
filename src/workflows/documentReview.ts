import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function getServiceRoleClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getServiceRoleClient();
}
import { isGeneralLiability } from "./complianceEngine";
import {
  InsuranceExtractionSchema,
  POLICY_TYPES,
  PolicyTypeSchema,
  type ExtractedPolicy,
  type InsuranceExtraction,
  type PolicyType,
} from "./insuranceExtractionSchema";
import {
  applyOnePolicyLine,
  assertPlatformAdmin,
  fetchActivePoliciesByType,
} from "./vendorUploadRequests";

/**
 * The review-queue screen's server functions: reading one queue item's full
 * detail, and resolving it with a human decision. Split from
 * vendorUploadRequests.ts (which still owns the automated extraction/match
 * path this reuses fetchActivePoliciesByType()/applyOnePolicyLine()/
 * assertPlatformAdmin() from) because this is a distinct workflow - a staff
 * member looking at something the automated path already gave up on -
 * rather than another step of the upload pipeline itself.
 *
 * Both functions run on the service role after assertPlatformAdmin(): see
 * that function's docblock and the one on getServiceRoleClient() in
 * serverClient.server.ts for why - can_write_company() is company-
 * membership-only, and VendorClr staff reviewing a customer's document
 * have none.
 */

const queueItemIdSchema = z.object({ queueItemId: z.string().uuid() });

export interface ReviewQueueItemDetail {
  queueItem: {
    id: string;
    state: string;
    resolution: "approved" | "rejected" | null;
    resolutionNote: string;
    resolvedAt: string | null;
    /** From audit_log's review_resolved row for this item (migration 14) - null until resolved, or if no matching row exists (a resolution predating migration 14). */
    resolvedByEmail: string | null;
    documentLabel: string;
    submittedOn: string;
  };
  vendor: {
    id: string;
    name: string;
    contactName: string;
    contactEmail: string;
    companyName: string;
  };
  /** Null only for a pre-migration-12 queue item the backfill could not link to any document. */
  document: {
    id: string;
    fileName: string;
    mimeType: string;
    processingStatus: string;
    processingError: string | null;
    reviewReason: string | null;
    parsedData: InsuranceExtraction | null;
    appliedPolicyId: string | null;
    /** Short-lived signed URL to the stored file, or null if it could not be generated. */
    viewUrl: string | null;
  } | null;
  /** The vendor's current active policies, keyed by type - the "what's on file" side of the comparison the screen renders. */
  existingPolicies: Array<{
    policyType: string;
    carrierName: string;
    policyNumber: string;
    expirationDate: string | null;
  }>;
  /**
   * Every document_extractions row for this document, oldest first. Model
   * attempts and reviewer revisions are separate immutable rows; `current`
   * marks the one vendor_documents.current_extraction_id points at.
   */
  extractions: ExtractionRevision[];
  /** Open compliance deficiencies for this vendor - the requirement shortfalls a reviewer weighs before approving. */
  shortfalls: Array<{
    id: string;
    requirementKey: string;
    kind: string | null;
    policyType: string | null;
    explanation: string;
    projectName: string | null;
  }>;
  /** audit_log rows for this document and this queue item, newest first. */
  history: Array<{
    id: string;
    action: string;
    createdAt: string;
    actorEmail: string | null;
    /** detail.note when the row carries one (review decisions do). */
    note: string | null;
  }>;
}

export interface ExtractionRevision {
  id: string;
  source: "model" | "reviewer_edit";
  model: string | null;
  promptVersion: string | null;
  confidence: number | null;
  createdAt: string;
  reviewerEmail: string | null;
  error: string | null;
  parsedData: InsuranceExtraction | null;
  current: boolean;
}

async function emailsFor(
  supabase: Awaited<ReturnType<typeof getServiceRoleClient>>,
  userIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const { data } = await supabase.from("profiles").select("id, email").in("id", ids);
  return new Map(
    ((data ?? []) as Array<{ id: string; email: string }>).map((p) => [p.id, p.email]),
  );
}

export const getReviewQueueItem = createServerFn({ method: "GET" })
  .validator(queueItemIdSchema)
  .handler(async ({ data }): Promise<ReviewQueueItemDetail> => {
    await assertPlatformAdmin();
    const supabase = await getServiceRoleClient();

    const { data: queueRow, error: queueError } = await supabase
      .from("compliance_queue_items")
      .select(
        "id, state, resolution, resolution_note, resolved_at, document_label, submitted_on, vendor_id, document_id",
      )
      .eq("id", data.queueItemId)
      .maybeSingle();

    if (queueError || !queueRow) throw new Error("Review item not found.");

    const { data: vendorRow, error: vendorError } = await supabase
      .from("vendors")
      .select("id, name, contact_name, contact_email, companies ( name )")
      .eq("id", queueRow.vendor_id)
      .maybeSingle();

    if (vendorError || !vendorRow) throw new Error("Vendor not found.");

    const vendor = vendorRow as unknown as {
      id: string;
      name: string;
      contact_name: string;
      contact_email: string;
      companies: { name: string } | null;
    };

    let document: ReviewQueueItemDetail["document"] = null;
    if (queueRow.document_id) {
      const { data: docRow } = await supabase
        .from("vendor_documents")
        .select(
          "id, file_name, mime_type, storage_path, processing_status, processing_error, review_reason, parsed_data, applied_policy_id, current_extraction_id",
        )
        .eq("id", queueRow.document_id)
        .maybeSingle();

      if (docRow) {
        // Short-lived: this detail view is opened, acted on, and closed in one
        // sitting, not a link that gets bookmarked or shared.
        const { data: signed } = await supabase.storage
          .from("vendor-documents")
          .createSignedUrl(docRow.storage_path, 600);

        document = {
          id: docRow.id,
          fileName: docRow.file_name,
          mimeType: docRow.mime_type,
          processingStatus: docRow.processing_status,
          processingError: docRow.processing_error,
          reviewReason: docRow.review_reason,
          parsedData: docRow.parsed_data as InsuranceExtraction | null,
          appliedPolicyId: docRow.applied_policy_id,
          viewUrl: signed?.signedUrl ?? null,
        };
      }
    }

    const existingByType = await fetchActivePoliciesByType(supabase, queueRow.vendor_id);

    let extractions: ExtractionRevision[] = [];
    if (document) {
      const [{ data: extractionRows }, { data: currentRow }] = await Promise.all([
        supabase
          .from("document_extractions")
          .select(
            "id, source, model, prompt_version, confidence, created_at, reviewer_id, error, parsed_data",
          )
          .eq("document_id", document.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("vendor_documents")
          .select("current_extraction_id")
          .eq("id", document.id)
          .maybeSingle(),
      ]);
      const rows = (extractionRows ?? []) as Array<{
        id: string;
        source: "model" | "reviewer_edit";
        model: string | null;
        prompt_version: string | null;
        confidence: number | null;
        created_at: string;
        reviewer_id: string | null;
        error: string | null;
        parsed_data: InsuranceExtraction | null;
      }>;
      const reviewerEmails = await emailsFor(
        supabase,
        rows.map((r) => r.reviewer_id),
      );
      extractions = rows.map((r) => ({
        id: r.id,
        source: r.source,
        model: r.model,
        promptVersion: r.prompt_version,
        confidence: r.confidence,
        createdAt: r.created_at,
        reviewerEmail: r.reviewer_id ? (reviewerEmails.get(r.reviewer_id) ?? null) : null,
        error: r.error,
        parsedData: r.parsed_data,
        current: r.id === currentRow?.current_extraction_id,
      }));
    }

    // Two plain reads (cases for this vendor, then their open deficiencies)
    // rather than filtering through an embedded resource - PostgREST embed
    // behavior is not exercised by the PGlite suite, so keep it to direct FKs.
    const { data: caseRows } = await supabase
      .from("compliance_cases")
      .select("id")
      .eq("vendor_id", queueRow.vendor_id);
    const caseIds = ((caseRows ?? []) as Array<{ id: string }>).map((c) => c.id);
    const { data: deficiencyRows } =
      caseIds.length === 0
        ? { data: [] }
        : await supabase
            .from("compliance_deficiencies")
            .select(
              "id, requirement_key, kind, policy_type, explanation, case:compliance_cases(assignment:project_vendor_assignments(project:projects(name)))",
            )
            .eq("status", "open")
            .in("case_id", caseIds);
    const shortfalls = (
      (deficiencyRows ?? []) as unknown as Array<{
        id: string;
        requirement_key: string;
        kind: string | null;
        policy_type: string | null;
        explanation: string;
        case: { assignment: { project: { name: string } | null } | null } | null;
      }>
    ).map((d) => ({
      id: d.id,
      requirementKey: d.requirement_key,
      kind: d.kind,
      policyType: d.policy_type,
      explanation: d.explanation,
      projectName: d.case?.assignment?.project?.name ?? null,
    }));

    const historyTargets = [queueRow.id, ...(document ? [document.id] : [])];
    const { data: auditRows } = await supabase
      .from("audit_log")
      .select("id, action, created_at, actor_id, detail")
      .in("target_id", historyTargets)
      .order("created_at", { ascending: false })
      .limit(50);
    const auditList = (auditRows ?? []) as Array<{
      id: string;
      action: string;
      created_at: string;
      actor_id: string | null;
      detail: unknown;
    }>;
    const actorEmails = await emailsFor(
      supabase,
      auditList.map((a) => a.actor_id),
    );
    const history = auditList.map((a) => ({
      id: a.id,
      action: a.action,
      createdAt: a.created_at,
      actorEmail: a.actor_id ? (actorEmails.get(a.actor_id) ?? null) : null,
      note:
        a.detail &&
        typeof a.detail === "object" &&
        typeof (a.detail as { note?: unknown }).note === "string"
          ? (a.detail as { note: string }).note
          : null,
    }));

    // Two steps, not a PostgREST embed: audit_log.actor_id references
    // auth.users, and profiles independently references auth.users too -
    // there is no FK from audit_log to profiles for PostgREST to embed
    // through (see fetchOwnerEmails()'s docblock in vendorUploadRequests.ts
    // for the confirmed-live failure this exact mistake produces elsewhere).
    let resolvedByEmail: string | null = null;
    if (queueRow.state === "resolved") {
      const { data: auditRow } = await supabase
        .from("audit_log")
        .select("actor_id")
        .eq("action", "review_resolved")
        .eq("target_type", "compliance_queue_item")
        .eq("target_id", queueRow.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (auditRow?.actor_id) {
        const { data: actorProfile } = await supabase
          .from("profiles")
          .select("email")
          .eq("id", auditRow.actor_id)
          .maybeSingle();
        resolvedByEmail = actorProfile?.email ?? null;
      }
    }

    return {
      queueItem: {
        id: queueRow.id,
        state: queueRow.state,
        resolution: queueRow.resolution,
        resolvedByEmail,
        resolutionNote: queueRow.resolution_note,
        resolvedAt: queueRow.resolved_at,
        documentLabel: queueRow.document_label,
        submittedOn: queueRow.submitted_on,
      },
      vendor: {
        id: vendor.id,
        name: vendor.name,
        contactName: vendor.contact_name,
        contactEmail: vendor.contact_email,
        companyName: vendor.companies?.name ?? "Unknown company",
      },
      document,
      existingPolicies: [...existingByType.entries()].map(([policyType, p]) => ({
        policyType,
        carrierName: p.carrierName,
        policyNumber: p.policyNumber,
        expirationDate: p.expirationDate,
      })),
      extractions,
      shortfalls,
      history,
    };
  });

// ---------------------------------------------------------------------------
// resolveReviewItem - the human decision
// ---------------------------------------------------------------------------

const selectedPolicyTypesSchema = z
  .array(PolicyTypeSchema)
  .min(1, "Select at least one coverage line to apply.")
  .max(POLICY_TYPES.length)
  .refine((types) => new Set(types).size === types.length, "Coverage lines must be unique.");

const resolveReviewItemSchema = z.discriminatedUnion("decision", [
  z.object({
    queueItemId: z.string().uuid(),
    decision: z.literal("approve"),
    selectedPolicyTypes: selectedPolicyTypesSchema,
    note: z.string().max(2000).optional(),
  }),
  z.object({
    queueItemId: z.string().uuid(),
    decision: z.literal("reject"),
    /** A rejection must say why - it is the only record of the reason. */
    note: z.string().trim().min(1, "Give a reason for rejecting this document.").max(2000),
  }),
]);

/**
 * Applies a reviewer's explicit selection to a freshly read extraction. The
 * client supplies only policy types; the authoritative policy details always
 * come from the document stored by the server.
 */
export function selectClassifiedPolicies(
  policies: ExtractedPolicy[],
  selectedPolicyTypes: PolicyType[],
): Array<ExtractedPolicy & { type: PolicyType }> {
  const selected = new Set(selectedPolicyTypes);
  return policies.filter(
    (policy): policy is ExtractedPolicy & { type: PolicyType } =>
      policy.type !== null && selected.has(policy.type),
  );
}

export interface ResolveReviewItemResult {
  decision: "approve" | "reject";
  /** How many reviewer-selected coverage lines on the certificate were written to vendor_policies. Always 0 for a reject. */
  appliedCount: number;
  /** Classified coverage types the reviewer explicitly left unchanged. */
  skippedPolicyTypes: PolicyType[];
  /** One entry per selected line apply_policy_renewal() itself failed on. */
  errors: string[];
}

/**
 * "Approve" applies only the classified coverage types the reviewer selected
 * in the confirmation step. The server re-reads the document's parsed data
 * and uses those types as a filter, so a browser never supplies policy values
 * to persist. Deselected lines are deliberately left unchanged and recorded
 * in the decision audit trail. This includes
 * matchExtractedPolicy()'s company-requirements check (migration 13) - a
 * human approving here can knowingly apply a certificate below what the
 * company requires, same as they can knowingly apply one with a changed
 * carrier; the requirement shortfall is still visible afterward on the
 * vendor's own Coverage Limits table (toCoverageLimits() reads carried
 * amounts live), it just doesn't block this screen's approve action the way
 * it blocks the automated path's auto-apply.
 *
 * Values come from vendor_documents.parsed_data, re-read fresh from the
 * database inside this handler - never from anything the client sent. A
 * reviewer approves *the document*, not a payload they could have edited in
 * the browser.
 *
 * A new_coverage line (no existing policy of that type on file) applies the
 * same way a renewal does - apply_policy_renewal()'s UPDATE is a no-op
 * against a null existing-policy id, so this is also the only path that can
 * ever record a vendor's first-ever policy of a given type; the automated
 * path always routes that to review and never applies it itself.
 */
export const resolveReviewItem = createServerFn({ method: "POST" })
  .validator(resolveReviewItemSchema)
  .handler(async ({ data }): Promise<ResolveReviewItemResult> => {
    const actorId = await assertPlatformAdmin();
    const supabase = await getServiceRoleClient();

    const { data: queueRow, error: queueError } = await supabase
      .from("compliance_queue_items")
      .select("id, state, vendor_id, company_id, document_id")
      .eq("id", data.queueItemId)
      .maybeSingle();

    if (queueError || !queueRow) throw new Error("Review item not found.");
    if (queueRow.state === "resolved") {
      throw new Error("This item has already been resolved.");
    }

    let appliedCount = 0;
    const errors: string[] = [];
    let appliedPolicyId: string | null = null;
    let classified: Array<ExtractedPolicy & { type: PolicyType }> = [];

    if (data.decision === "approve") {
      if (!queueRow.document_id) {
        throw new Error("No document is linked to this review item - nothing to approve.");
      }

      const { data: docRow, error: docError } = await supabase
        .from("vendor_documents")
        .select("id, parsed_data")
        .eq("id", queueRow.document_id)
        .maybeSingle();

      if (docError || !docRow) throw new Error("Document not found.");

      const parsed = docRow.parsed_data as InsuranceExtraction | null;
      classified = (parsed?.policies ?? []).filter(
        (p): p is ExtractedPolicy & { type: PolicyType } => p.type !== null,
      );

      if (classified.length === 0) {
        throw new Error(
          "This document has no classified coverage lines to apply - reprocess it, or reject this item instead.",
        );
      }

      const selected = selectClassifiedPolicies(parsed?.policies ?? [], data.selectedPolicyTypes);
      if (selected.length === 0) {
        throw new Error(
          "None of the selected coverage lines remain classified on this document. Reprocess it before applying changes.",
        );
      }

      const existingByType = await fetchActivePoliciesByType(supabase, queueRow.vendor_id);

      for (const policy of selected) {
        const existing = existingByType.get(policy.type) ?? null;
        const result = await applyOnePolicyLine(supabase, {
          companyId: queueRow.company_id,
          vendorId: queueRow.vendor_id,
          existingPolicyId: existing?.id ?? null,
          policy,
          certificateHolder: parsed?.certificate_holder ?? { name: null, address: null },
        });

        if ("error" in result) {
          errors.push(`${policy.type}: ${result.error}`);
          continue;
        }

        appliedCount++;
        if (isGeneralLiability(policy.type) || appliedPolicyId === null) {
          appliedPolicyId = result.newPolicyId;
        }
      }

      if (appliedCount === 0) {
        throw new Error(`Nothing could be applied: ${errors.join(" ")}`);
      }

      await supabase
        .from("vendor_documents")
        .update({
          processing_status: "processed",
          review_reason: null,
          applied_policy_id: appliedPolicyId,
          processed_at: new Date().toISOString(),
        })
        .eq("id", queueRow.document_id);
    }

    const skippedPolicyTypes =
      data.decision === "approve"
        ? [...new Set(classified.map((policy) => policy.type))].filter(
            (type) => !data.selectedPolicyTypes.includes(type),
          )
        : [];

    const resolutionNote =
      data.note?.trim() ||
      (data.decision === "approve"
        ? errors.length > 0
          ? `Applied ${appliedCount} selected coverage line(s); ${errors.join(" ")}`
          : `Applied ${appliedCount} selected coverage line(s) on reviewer approval.`
        : "Dismissed by reviewer.");

    await supabase
      .from("compliance_queue_items")
      .update({
        state: "resolved",
        resolution: data.decision === "approve" ? "approved" : "rejected",
        resolution_note: resolutionNote,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", queueRow.id);

    // On the service role, so actor_id's auth.uid() default would resolve
    // to nothing - passed explicitly from assertPlatformAdmin()'s own
    // RLS-checked lookup instead.
    await supabase.from("audit_log").insert({
      company_id: queueRow.company_id,
      actor_id: actorId,
      action: "review_resolved",
      target_type: "compliance_queue_item",
      target_id: queueRow.id,
      detail: {
        decision: data.decision,
        appliedCount,
        skippedPolicyTypes,
        errors,
        note: resolutionNote,
      },
    });

    return { decision: data.decision, appliedCount, skippedPolicyTypes, errors };
  });

// ---------------------------------------------------------------------------
// saveExtractionEdit - reviewer correction, Task 9a
// ---------------------------------------------------------------------------

const saveExtractionEditSchema = z.object({
  documentId: z.string().uuid(),
  // The full corrected extraction, not a partial patch - validated against
  // the same schema a model attempt must pass, so a reviewer-authored
  // revision is exactly as structurally trustworthy as a model one (same
  // tri-state discipline: a field the reviewer leaves undetermined must be
  // explicit null, not silently coerced by a partial-merge that could paper
  // over a field the reviewer never actually looked at).
  correctedData: InsuranceExtractionSchema,
});

export interface SaveExtractionEditResult {
  /** The new document_extractions row id - the reviewer-authored revision, never a mutation of the model's own row. */
  extractionId: string;
}

/**
 * "Saving an edit creates a reviewer-authored extraction revision; it never
 * overwrites model output" (Task 9a's own checklist wording). Staff-only,
 * same assertPlatformAdmin()-first discipline as every other service-role
 * handler in this file and vendorUploadRequests.ts - a reviewer correcting
 * a customer's document is exactly the kind of cross-tenant action RLS's
 * ordinary company-membership policies were never meant to grant, and
 * record_document_extraction() below has no authorization check of its own
 * to rely on (see that function's migration docblock for why: it is never
 * reachable by anything but the service-role client this handler drops to
 * only AFTER assertPlatformAdmin() succeeds).
 *
 * record_document_extraction() does the actual work in one call: inserts an
 * immutable document_extractions row (source = 'reviewer_edit', attributed
 * to this reviewer's own user id - "edits are attributable"), and moves
 * vendor_documents.current_extraction_id (and its parsed_data/
 * extraction_confidence cache) to point at it. The ORIGINAL model-authored
 * row this superseded is untouched and still queryable - it is a new row,
 * never an UPDATE of the old one. confidence is recorded as null for a
 * reviewer_edit row: a human correction carries no model self-assessment to
 * report, and null here means exactly what it means everywhere else in this
 * schema - "not applicable / not determined by a model", not zero
 * confidence.
 *
 * Does not itself touch compliance_queue_items or vendor_policies - saving
 * a correction is a distinct action from resolveReviewItem()'s
 * approve/reject decision, which still re-reads vendor_documents.parsed_data
 * fresh (now reflecting this edit, since the cache was just updated) when a
 * reviewer goes on to approve.
 */
/** Structural subset of the service-role client this handler touches - lets a unit test pass a fake. */
export interface ExtractionEditClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: { id: string; company_id: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
    insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
  rpc(
    fn: "record_document_extraction",
    params: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/**
 * The testable core of saveExtractionEdit(). Its ONLY write to extraction
 * data is record_document_extraction() with source 'reviewer_edit' - which
 * inserts a NEW document_extractions row attributed to the reviewer and
 * repoints vendor_documents.current_extraction_id at it. The model's own row
 * is never updated (and since 20260922140000 the database rejects any UPDATE
 * on document_extractions outright).
 */
export async function saveExtractionEditHandler(
  supabase: ExtractionEditClient,
  actorId: string,
  data: z.infer<typeof saveExtractionEditSchema>,
): Promise<SaveExtractionEditResult> {
  const { data: docRow, error: docError } = await supabase
    .from("vendor_documents")
    .select("id, company_id")
    .eq("id", data.documentId)
    .maybeSingle();

  if (docError || !docRow) throw new Error("Document not found.");

  const { data: extractionId, error: rpcError } = await supabase.rpc("record_document_extraction", {
    p_document_id: docRow.id,
    p_company_id: docRow.company_id,
    p_source: "reviewer_edit",
    p_provider: null,
    p_model: null,
    p_prompt_version: null,
    p_confidence: null,
    p_parsed_data: data.correctedData,
    p_error: null,
    p_reviewer_id: actorId,
  });

  if (rpcError || !extractionId) {
    throw new Error(rpcError?.message ?? "Could not save this correction. Try again.");
  }

  await supabase.from("audit_log").insert({
    company_id: docRow.company_id,
    actor_id: actorId,
    action: "extraction_reviewer_edit",
    target_type: "vendor_document",
    target_id: docRow.id,
    detail: { extractionId },
  });

  return { extractionId: extractionId as string };
}

export const saveExtractionEdit = createServerFn({ method: "POST" })
  .validator(saveExtractionEditSchema)
  .handler(async ({ data }): Promise<SaveExtractionEditResult> => {
    const actorId = await assertPlatformAdmin();
    const supabase = await getServiceRoleClient();
    return saveExtractionEditHandler(supabase as unknown as ExtractionEditClient, actorId, data);
  });
