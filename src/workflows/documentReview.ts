import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function getServiceRoleClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getServiceRoleClient();
}
import { isGeneralLiability } from "./complianceEngine";
import type { ExtractedPolicy, InsuranceExtraction } from "./insuranceExtractionSchema";
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
          "id, file_name, mime_type, storage_path, processing_status, processing_error, review_reason, parsed_data, applied_policy_id",
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
    };
  });

// ---------------------------------------------------------------------------
// resolveReviewItem - the human decision
// ---------------------------------------------------------------------------

const resolveReviewItemSchema = z.object({
  queueItemId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});

export interface ResolveReviewItemResult {
  decision: "approve" | "reject";
  /** How many classified coverage lines on the certificate were written to vendor_policies. Always 0 for a reject. */
  appliedCount: number;
  /** One entry per classified line apply_policy_renewal() itself failed on - not lines the reviewer chose to skip, there is no such thing here (see the module docblock: approve is all-classified-lines-or-nothing). */
  errors: string[];
}

/**
 * "Approve" applies EVERY classified coverage line on the certificate, not
 * just the one that originally triggered review - the same all-or-nothing
 * shape the automated path already uses per-document, just without
 * matchExtractedPolicy() gating which lines qualify. A human looking at the
 * whole certificate and deciding "yes, apply this" is exactly the override
 * that gate exists to defer to; there is no partial-approval UI here (see
 * "Known compromises" in supabase/README.md). This includes
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
      const classified = (parsed?.policies ?? []).filter(
        (p): p is ExtractedPolicy & { type: NonNullable<ExtractedPolicy["type"]> } =>
          p.type !== null,
      );

      if (classified.length === 0) {
        throw new Error(
          "This document has no classified coverage lines to apply - reprocess it, or reject this item instead.",
        );
      }

      const existingByType = await fetchActivePoliciesByType(supabase, queueRow.vendor_id);

      for (const policy of classified) {
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

    const resolutionNote =
      data.note?.trim() ||
      (data.decision === "approve"
        ? errors.length > 0
          ? `Applied ${appliedCount} of ${appliedCount + errors.length} coverage lines on reviewer approval; ${errors.join(" ")}`
          : `Applied all ${appliedCount} coverage line(s) on reviewer approval.`
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
      detail: { decision: data.decision, appliedCount, errors, note: resolutionNote },
    });

    return { decision: data.decision, appliedCount, errors };
  });
