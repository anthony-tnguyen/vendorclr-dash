// @ts-nocheck - this file runs in Supabase's Deno Edge Runtime, not the app's
// Node/TypeScript project; its imports (jsr:, npm:) and Deno globals are not
// resolvable by the repo's own tsc/eslint config, which is why it is excluded
// there (see eslint.config.js) and verified instead by deploying it and
// invoking it against the live project (supabase/README.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.122.0";

import {
  computeComplianceItems,
  hasUnclassifiedPolicy,
  isGeneralLiability,
  matchExtractedPolicy,
  type ExistingPolicySnapshot,
  type RequirementSnapshot,
} from "./complianceEngine.ts";
import { extractDocument, type ExtractDocumentResult } from "./documentExtraction.ts";
import {
  adminReviewNeededHtml,
  adminReviewNeededSubject,
  adminReviewNeededText,
  documentReceivedHtml,
  documentReceivedSubject,
  documentReceivedText,
} from "./emailTemplates.ts";
import type { ExtractedPolicy } from "./insuranceExtractionSchema.ts";
import { logOperational, newRequestId } from "./operationalLog.ts";

/**
 * Triggered every minute by pg_cron -> pg_net (see
 * supabase/migrations/20260917000700_schedule_document_processing_jobs.sql),
 * never by a user. Claims a batch of due document_processing_jobs rows
 * atomically (claim_document_processing_jobs() - 20260917000600, `for
 * update skip locked` so two overlapping invocations can never grab the
 * same row) and, for each, downloads the stored file, extracts it, and
 * applies the result - the async replacement for the synchronous extraction
 * uploadDocumentForTokenHandler()/finalizePackageHandler() used to run
 * inline before Task 8a switched them to enqueue-not-extract.
 *
 * ---------------------------------------------------------------------------
 * Why this file PORTS the compliance-matching engine, unlike
 * retry-failed-documents/index.ts's deliberate "always needs_review"
 * shortcut
 * ---------------------------------------------------------------------------
 * retry-failed-documents only ever re-processes a document that has ALREADY
 * failed once and is already sitting in a human's review queue - writing
 * its recovered result as needs_review costs that document nothing, because
 * a person was always going to look at it anyway.
 *
 * This function is different: it processes FIRST-TIME extractions for
 * freshly-submitted documents. Before Task 8a, that exact extraction ran
 * synchronously in uploadDocumentForTokenHandler()/applyExtractionResult()
 * (src/workflows/vendorUploadRequests.ts) and a clean, deterministic match
 * (matchExtractedPolicy() in complianceEngine.ts) auto-applied straight to
 * vendor_policies with NO human review - that is this app's Phase 3
 * feature, and the majority of clean vendor renewals clear this way today.
 * If this worker took retry-failed-documents' shortcut, moving extraction
 * off the request path would silently turn every single submission into a
 * human-review item - a real product regression hiding inside what looks
 * like "just make this async."
 *
 * So this file ports complianceEngine.ts's pure matching functions
 * (byte-for-byte, in ./complianceEngine.ts - no I/O, trivially portable,
 * unlike the "much bigger duplication" retry-failed-documents' own docblock
 * was avoiding) and reimplements applyComplianceEngine()/applyOnePolicyLine()'s
 * orchestration NATIVELY here as ordinary Deno supabase-js calls (including
 * apply_policy_renewal(), the same RPC the Node app calls) - not a port of
 * that orchestration, a fresh implementation against this runtime's own
 * client, the same way retry-failed-documents/index.ts already talks to the
 * database. A clean match still auto-applies exactly as it does today.
 *
 * ---------------------------------------------------------------------------
 * Bounded retries + backoff
 * ---------------------------------------------------------------------------
 * A vendor is waiting minutes, not hours, to see their submission "go
 * through" - a completely different latency budget than
 * retry-failed-documents' hours-scale schedule (built for "the vendor has
 * already left the page"). BACKOFF_SECONDS_BY_ATTEMPT below is
 * seconds-to-low-minutes (15s, 45s, 2m, 5m) against a 5-attempt cap
 * (document_processing_jobs.max_attempts, defaulted in the migration) -
 * worst case, a document experiencing genuine repeated failures reaches
 * 'exhausted' in under ~8 minutes of backoff plus at most one minute of
 * cron scheduling latency per attempt. A transient blip that recovers on
 * attempt 2 or 3 costs the vendor well under a minute.
 *
 * Deliberately does NOT touch vendor_documents.retry_count/next_retry_at or
 * write vendor_documents.processing_status = 'failed' while a job is still
 * retryable (attempt_count < max_attempts) - those columns and that value
 * are exactly what documents_due_for_retry (20260903000300) filters on to
 * feed retry-failed-documents' own hourly cron. Writing 'failed' mid-retry
 * here would make that OLD system pick up and re-extract the SAME document
 * while this NEW queue is still actively retrying it too - genuinely
 * duplicate concurrent processing, not just duplicated logic (which the
 * task's own non-goals explicitly accept between these two functions).
 * vendor_documents is only ever touched here on a TERMINAL outcome of this
 * job (succeeded -> processed/needs_review, or exhausted -> failed) - see
 * finalizeSuccess()/finalizeExhaustion() below. Once genuinely exhausted,
 * vendor_documents.processing_status = 'failed' with retry_count/
 * next_retry_at left at their defaults (0/null) is a deliberate, accepted
 * handoff: the OLD hourly safety net can still pick the document up later
 * and recover it into needs_review (never writing vendor_policies itself -
 * see its own docblock), which is a genuine second chance, not a race,
 * because by then this job is permanently 'exhausted' and can never be
 * reclaimed again (see claim_document_processing_jobs()'s eligibility
 * list).
 *
 * Also unlike the old synchronous path, a single transient failure no
 * longer immediately emails the vendor "we hit an issue" -
 * notifyDocumentOutcome() below only fires once this job reaches a terminal
 * outcome, sparing the vendor a spurious failure email for a blip that
 * recovers on the very next attempt a few seconds later.
 *
 * Runs on the service role: there is no signed-in user to run this as, and
 * a claimed batch can span multiple companies in one invocation.
 */

/** Matches EXTRACTION_SCHEMA_VERSION in src/workflows/insuranceExtractionSchema.ts exactly - keep the two in sync. */
const EXTRACTION_SCHEMA_VERSION = "2026-09-16-task9a";

const BATCH_SIZE = 10;
const BACKOFF_SECONDS_BY_ATTEMPT = [15, 45, 120, 300];
const RESEND_ENDPOINT = "https://api.resend.com/emails";
// Matches send-renewal-reminders/index.ts's FROM_ADDRESS exactly - see its
// own comment for why the bare vendorclr.com domain cannot be used.
const FROM_ADDRESS = "VendorClr <onboarding@compliance.vendorclr.com>";

/** vendor_policies' column names -> ExtractedPolicy["limits"]'s key names - matches LIMIT_FIELD_TO_EXTRACTED_KEY in vendorUploadRequests.ts. */
const LIMIT_FIELD_TO_EXTRACTED_KEY: Record<string, RequirementSnapshot["limitField"]> = {
  each_occurrence_limit: "each_occurrence",
  general_aggregate_limit: "general_aggregate",
};

interface ClaimedJob {
  id: string;
  company_id: string;
  vendor_id: string;
  target_document_id: string;
  target_package_id: string | null;
  attempt_count: number;
  max_attempts: number;
}

/** Defense in depth on top of the platform's own verify_jwt check - see send-renewal-reminders/index.ts's identical helper for the full reasoning. */
function isServiceRoleRequest(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return false;
  try {
    const json = atob(payloadSegment.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { role?: string };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Compliance-engine orchestration - native Deno implementation of
// applyOnePolicyLine()/applyComplianceEngine() in vendorUploadRequests.ts,
// against complianceEngine.ts's ported pure functions. See this file's top
// docblock for why this is ported/reimplemented rather than shortcut.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function fetchActivePoliciesByType(
  supabase: any,
  vendorId: string,
): Promise<Map<string, ExistingPolicySnapshot>> {
  const { data: activePolicies } = await supabase
    .from("vendor_policies")
    .select("id, policy_type, carrier_name, policy_number, expiration_date")
    .eq("vendor_id", vendorId)
    .eq("status", "active");

  return new Map<string, ExistingPolicySnapshot>(
    (
      (activePolicies ?? []) as Array<{
        id: string;
        policy_type: string;
        carrier_name: string;
        policy_number: string;
        expiration_date: string | null;
      }>
    ).map((p) => [
      p.policy_type,
      {
        id: p.id,
        carrierName: p.carrier_name,
        policyNumber: p.policy_number,
        expirationDate: p.expiration_date,
      },
    ]),
  );
}

// deno-lint-ignore no-explicit-any
async function fetchRequirementsByType(
  supabase: any,
  companyId: string,
): Promise<Map<string, RequirementSnapshot[]>> {
  const { data: requirements } = await supabase
    .from("compliance_requirements")
    .select("label, policy_type, limit_field, required_amount")
    .eq("company_id", companyId);

  const byType = new Map<string, RequirementSnapshot[]>();
  for (const req of (requirements ?? []) as Array<{
    label: string;
    policy_type: string;
    limit_field: string;
    required_amount: number;
  }>) {
    const limitField = LIMIT_FIELD_TO_EXTRACTED_KEY[req.limit_field];
    if (!limitField) continue;
    const snapshot: RequirementSnapshot = {
      label: req.label,
      limitField,
      requiredAmount: req.required_amount,
    };
    const existing = byType.get(req.policy_type);
    if (existing) existing.push(snapshot);
    else byType.set(req.policy_type, [snapshot]);
  }
  return byType;
}

async function applyOnePolicyLine(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  params: {
    companyId: string;
    vendorId: string;
    existingPolicyId: string | null;
    policy: ExtractedPolicy & { type: NonNullable<ExtractedPolicy["type"]> };
    certificateHolder: { name: string | null; address: string | null };
  },
): Promise<{ newPolicyId: string } | { error: string }> {
  const { companyId, vendorId, existingPolicyId, policy, certificateHolder } = params;

  const { data: newPolicyId, error: rpcError } = await supabase.rpc("apply_policy_renewal", {
    p_company_id: companyId,
    p_vendor_id: vendorId,
    p_existing_policy_id: existingPolicyId,
    p_policy_type: policy.type,
    p_carrier_name: policy.carrier,
    p_policy_number: policy.policy_number,
    p_effective_date: policy.effective_date,
    p_expiration_date: policy.expiration_date,
    p_each_occurrence_limit: policy.limits.each_occurrence ?? null,
    p_general_aggregate_limit: policy.limits.general_aggregate ?? null,
    p_additional_insured: policy.additional_insured,
    p_waiver_of_subrogation: policy.waiver_of_subrogation,
    p_certificate_holder_name: certificateHolder.name,
    p_certificate_holder_address: certificateHolder.address,
    p_primary_noncontributory: policy.primary_noncontributory,
  });

  if (rpcError || !newPolicyId) {
    return { error: rpcError?.message ?? "apply_policy_renewal returned no id" };
  }

  if (isGeneralLiability(policy.type)) {
    const items = computeComplianceItems({
      isPrimaryPolicy: true,
      expirationDate: policy.expiration_date,
      additionalInsured: policy.additional_insured,
      waiverOfSubrogation: policy.waiver_of_subrogation,
    });

    await supabase.from("vendor_compliance_items").upsert(
      (Object.keys(items) as Array<keyof typeof items>).map((key) => ({
        company_id: companyId,
        vendor_id: vendorId,
        requirement_key: key,
        status: items[key].status,
        effective_date: items[key].effectiveDate,
        note: items[key].note ?? null,
      })),
      { onConflict: "vendor_id,requirement_key" },
    );
  }

  return { newPolicyId: newPolicyId as string };
}

async function applyComplianceEngine(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  params: {
    companyId: string;
    vendorId: string;
    policies: ExtractedPolicy[];
    certificateHolder: { name: string | null; address: string | null };
  },
): Promise<{ allMatched: boolean; appliedPolicyId: string | null; reasons: string[] }> {
  const { companyId, vendorId, policies, certificateHolder } = params;
  const reasons: string[] = [];
  let appliedPolicyId: string | null = null;
  let allMatched = true;

  if (hasUnclassifiedPolicy(policies)) {
    allMatched = false;
    reasons.push("The certificate lists a coverage type that could not be classified.");
  }

  const classified = policies.filter(
    (p): p is ExtractedPolicy & { type: NonNullable<ExtractedPolicy["type"]> } => p.type !== null,
  );
  if (classified.length === 0) return { allMatched, appliedPolicyId, reasons };

  const [existingByType, requirementsByType] = await Promise.all([
    fetchActivePoliciesByType(supabase, vendorId),
    fetchRequirementsByType(supabase, companyId),
  ]);

  for (const extracted of classified) {
    const outcome = matchExtractedPolicy(
      extracted,
      existingByType.get(extracted.type) ?? null,
      requirementsByType.get(extracted.type) ?? [],
    );

    if (outcome.kind !== "renew") {
      allMatched = false;
      reasons.push(
        outcome.kind === "new_coverage"
          ? `${extracted.type}: no existing policy on file to renew against - first submission for this coverage type needs review.`
          : `${extracted.type}: ${outcome.reason}`,
      );
      continue;
    }

    const result = await applyOnePolicyLine(supabase, {
      companyId,
      vendorId,
      existingPolicyId: outcome.existingPolicyId,
      policy: extracted,
      certificateHolder,
    });

    if ("error" in result) {
      allMatched = false;
      reasons.push(
        `${extracted.type}: matched cleanly but the database update failed - try reprocessing.`,
      );
      continue;
    }

    if (isGeneralLiability(extracted.type)) {
      appliedPolicyId = result.newPolicyId;
    } else if (appliedPolicyId === null) {
      appliedPolicyId = result.newPolicyId;
    }
  }

  return { allMatched, appliedPolicyId, reasons };
}

// ---------------------------------------------------------------------------
// Notification - native Deno reimplementation of notifyDocumentOutcome()/
// fetchOwnerEmails() in vendorUploadRequests.ts, calling Resend directly the
// same way send-renewal-reminders/index.ts already does (there is no
// getEmailSender() in this runtime - that module is Node-only).
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function fetchOwnerEmails(supabase: any, companyId: string): Promise<string[]> {
  const { data: owners } = await supabase
    .from("company_members")
    .select("user_id")
    .eq("company_id", companyId)
    .eq("role", "owner");

  const ownerUserIds = ((owners ?? []) as Array<{ user_id: string }>).map((o) => o.user_id);
  if (ownerUserIds.length === 0) return [];

  const { data: profiles } = await supabase.from("profiles").select("email").in("id", ownerUserIds);
  return ((profiles ?? []) as Array<{ email: string }>)
    .map((p) => p.email)
    .filter((email): email is string => Boolean(email));
}

async function sendViaResend(
  resendApiKey: string | undefined,
  input: { to: string; subject: string; html: string; text: string },
): Promise<{
  status: "sent" | "failed" | "not_configured";
  providerMessageId: string | null;
  error: string | null;
}> {
  if (!resendApiKey) return { status: "not_configured", providerMessageId: null, error: null };

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
    if (response.ok) return { status: "sent", providerMessageId: body.id ?? null, error: null };
    return {
      status: "failed",
      providerMessageId: null,
      error: body.message ?? `Resend responded ${response.status}`,
    };
  } catch (error) {
    return {
      status: "failed",
      providerMessageId: null,
      error: error instanceof Error ? error.message : "Unknown error sending email",
    };
  }
}

/**
 * The suppression gate - the Deno twin of sendUnlessSuppressed() in
 * src/workflows/suppression.ts (this runtime cannot import that module).
 * Never hands Resend an address public.is_email_suppressed() reports as
 * suppressed for the company (hard bounce, spam complaint, manual
 * do-not-email). Fails closed: if the check itself errors, nothing is sent.
 */
async function sendUnlessSuppressed(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  resendApiKey: string | undefined,
  companyId: string,
  input: { to: string; subject: string; html: string; text: string },
): Promise<{
  status: "sent" | "failed" | "not_configured" | "suppressed";
  providerMessageId: string | null;
  error: string | null;
}> {
  const { data: suppressed, error } = await supabase.rpc("is_email_suppressed", {
    p_company_id: companyId,
    p_email: input.to,
  });
  if (error) {
    return {
      status: "failed",
      providerMessageId: null,
      error: `Not sent: could not verify suppression status (${error.message}).`,
    };
  }
  if (suppressed === true) {
    return {
      status: "suppressed",
      providerMessageId: null,
      error: "Not sent: address is suppressed (bounced, complained or marked do-not-email).",
    };
  }
  return sendViaResend(resendApiKey, input);
}

function outboxStatusFor(status: "sent" | "failed" | "not_configured" | "suppressed"): string {
  return status === "not_configured" ? "queued" : status;
}

/** Never throws - a notification failure must not undo work this job already committed. */
async function notifyDocumentOutcome(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  resendApiKey: string | undefined,
  params: {
    companyId: string;
    vendorId: string;
    documentFileName: string;
    finalStatus: "processed" | "needs_review" | "failed";
    reviewReason: string | null;
    processingError: string | null;
  },
): Promise<void> {
  try {
    const { data: vendorRow } = await supabase
      .from("vendors")
      .select("name, contact_name, contact_email, companies ( name )")
      .eq("id", params.vendorId)
      .maybeSingle();

    const vendor = vendorRow as {
      name: string;
      contact_name: string;
      contact_email: string;
      companies: { name: string } | null;
    } | null;

    if (vendor?.contact_email) {
      const emailInput = {
        vendorContactName: vendor.contact_name ?? "",
        vendorName: vendor.name,
        companyName: vendor.companies?.name ?? "your client",
        outcome: params.finalStatus,
      };
      const sendResult = await sendUnlessSuppressed(supabase, resendApiKey, params.companyId, {
        to: vendor.contact_email,
        subject: documentReceivedSubject(emailInput),
        html: documentReceivedHtml(emailInput),
        text: documentReceivedText(emailInput),
      });
      await supabase.from("email_outbox").insert({
        company_id: params.companyId,
        vendor_id: params.vendorId,
        template: "document_received",
        to_email: vendor.contact_email,
        status: outboxStatusFor(sendResult.status),
        provider_message_id: sendResult.providerMessageId,
        error: sendResult.error,
        sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
      });
    }

    if (params.finalStatus === "needs_review" || params.finalStatus === "failed") {
      const ownerEmails = await fetchOwnerEmails(supabase, params.companyId);
      if (ownerEmails.length > 0) {
        const emailInput = {
          vendorName: vendor?.name ?? "A vendor",
          documentFileName: params.documentFileName,
          outcome: params.finalStatus,
          reason: params.reviewReason ?? params.processingError,
        };
        for (const to of ownerEmails) {
          const sendResult = await sendUnlessSuppressed(supabase, resendApiKey, params.companyId, {
            to,
            subject: adminReviewNeededSubject(emailInput),
            html: adminReviewNeededHtml(emailInput),
            text: adminReviewNeededText(emailInput),
          });
          await supabase.from("email_outbox").insert({
            company_id: params.companyId,
            vendor_id: params.vendorId,
            template: "admin_review_needed",
            to_email: to,
            status: outboxStatusFor(sendResult.status),
            provider_message_id: sendResult.providerMessageId,
            error: sendResult.error,
            sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
          });
        }
      }
    }
  } catch {
    // Never let a notification failure surface as a job failure - the
    // document's outcome is already durably recorded by this point.
  }
}

// ---------------------------------------------------------------------------
// Per-job processing
// ---------------------------------------------------------------------------

/**
 * A job's attempt reached extraction success - writes vendor_documents,
 * nudges compliance_queue_items, notifies, and marks the job 'succeeded'.
 *
 * Returns "succeeded" on the normal path. If record_document_extraction()
 * itself fails to write (see below), this is no longer a success at all -
 * it defers to recordJobFailure() and returns whatever THAT returns
 * ("retrying" or "exhausted"), exactly like every other attempt failure in
 * this file (download/extraction failures, an unhandled exception). This
 * keeps the retry-budget self-healing property intact for a transient RPC
 * blip, and keeps vendor_documents.processing_status = 'failed' reserved
 * for genuine exhaustion only - see this file's top docblock's backoff
 * section for why writing 'failed' mid-retry would be wrong.
 *
 * record_document_extraction() runs BEFORE applyComplianceEngine() -
 * deliberately, not the historical order. applyComplianceEngine() writes
 * vendor_policies via apply_policy_renewal() (superseding the vendor's
 * current active policy and inserting a new active one at the extracted
 * expiration date - see that RPC's migration). If it ran first and THEN
 * record_document_extraction() failed, the bounded-backoff retry
 * (recordJobFailure() below) would re-run applyComplianceEngine() from
 * scratch on the next attempt, re-matching the SAME extracted policy
 * against the vendor's now-already-renewed active policy: matchExtractedPolicy()
 * (complianceEngine.ts) would see the extracted expiration date as no later
 * than the (already-updated) one on file and wrongly reject a clean renewal
 * as needs_review, even though it was already correctly applied. Recording
 * the extraction first means a retry can only ever re-enter
 * applyComplianceEngine() when no compliance write happened on the prior
 * attempt, so it always starts from the vendor's true pre-renewal state.
 */
async function finalizeSuccess(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  resendApiKey: string | undefined,
  job: ClaimedJob,
  doc: { file_name: string },
  extraction: ExtractDocumentResult,
): Promise<"succeeded" | "retrying" | "exhausted"> {
  // Task 9a: record_document_extraction() inserts the immutable
  // document_extractions row for this attempt AND refreshes
  // vendor_documents.parsed_data/extraction_confidence/current_extraction_id
  // in one call - see that function's migration docblock
  // (20260917000900_versioned_extractions.sql) for why this replaced a
  // direct .update() of those two columns, and why this Edge Function calls
  // the same RPC the Node app does rather than duplicating the
  // insert-plus-cache-refresh logic here.
  const { error: recordExtractionError } = await supabase.rpc("record_document_extraction", {
    p_document_id: job.target_document_id,
    p_company_id: job.company_id,
    p_source: "model",
    p_provider: "anthropic",
    p_model: "claude-opus-5",
    p_prompt_version: EXTRACTION_SCHEMA_VERSION,
    p_confidence: extraction.confidence,
    p_parsed_data: extraction.data,
    p_error: extraction.error,
  });

  // The attempt row/cache refresh above failed to write - this attempt did
  // not produce a usable, recorded result, so it must not be treated as a
  // success. Hand off to the exact same bounded-backoff path as any other
  // attempt failure, rather than writing vendor_documents ourselves here.
  // Crucially, applyComplianceEngine() has NOT run yet at this point (see
  // this function's docblock), so the retry this triggers starts clean.
  if (recordExtractionError) {
    logOperational({
      level: "error",
      event: "record_document_extraction_failed",
      requestId: newRequestId(),
      companyId: job.company_id,
      route: "process-document-jobs",
      outcome: "failure",
      errorCode: "record_document_extraction_rpc_error",
    });
    return recordJobFailure(
      supabase,
      resendApiKey,
      job,
      doc,
      `Could not record the extraction result: ${recordExtractionError.message}`,
    );
  }

  let finalStatus: "processed" | "needs_review" | "failed" = extraction.status;
  let reviewReason: string | null = null;
  let appliedPolicyId: string | null = null;

  if (extraction.status === "processed" && extraction.data) {
    const result = await applyComplianceEngine(supabase, {
      companyId: job.company_id,
      vendorId: job.vendor_id,
      policies: extraction.data.policies,
      certificateHolder: extraction.data.certificate_holder,
    });
    appliedPolicyId = result.appliedPolicyId;
    if (!result.allMatched) {
      finalStatus = "needs_review";
      reviewReason = result.reasons.join(" ");
    }
  }

  await supabase
    .from("vendor_documents")
    .update({
      processing_status: finalStatus,
      processing_error: extraction.error,
      review_reason: reviewReason,
      applied_policy_id: appliedPolicyId,
      processed_at: new Date().toISOString(),
    })
    .eq("id", job.target_document_id);

  if (finalStatus === "needs_review" || finalStatus === "failed") {
    const { data: queueItem } = await supabase
      .from("compliance_queue_items")
      .select("id, state")
      .eq("document_id", job.target_document_id)
      .maybeSingle();
    if (queueItem && queueItem.state !== "resolved") {
      await supabase
        .from("compliance_queue_items")
        .update({ state: "in-review" })
        .eq("id", queueItem.id);
    }
  }

  await notifyDocumentOutcome(supabase, resendApiKey, {
    companyId: job.company_id,
    vendorId: job.vendor_id,
    documentFileName: doc.file_name,
    finalStatus,
    reviewReason,
    processingError: extraction.error,
  });

  await supabase
    .from("document_processing_jobs")
    .update({ status: "succeeded", last_error: null })
    .eq("id", job.id);

  return "succeeded";
}

/** A job's attempt failed (extraction error, download error, or an unexpected exception) - schedules a backoff retry, or exhausts the job and finalizes vendor_documents/notifies if the attempt budget is spent. */
async function recordJobFailure(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  resendApiKey: string | undefined,
  job: ClaimedJob,
  doc: { file_name: string } | null,
  errorMessage: string,
): Promise<"retrying" | "exhausted"> {
  if (job.attempt_count < job.max_attempts) {
    const backoffSeconds =
      BACKOFF_SECONDS_BY_ATTEMPT[
        Math.min(job.attempt_count, BACKOFF_SECONDS_BY_ATTEMPT.length) - 1
      ];
    const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    await supabase
      .from("document_processing_jobs")
      .update({ status: "failed", last_error: errorMessage, next_attempt_at: nextAttemptAt })
      .eq("id", job.id);
    return "retrying";
  }

  // Attempt budget spent - this is the job's terminal failure. See this
  // file's top docblock for why vendor_documents.processing_status is only
  // ever written to 'failed' here, at genuine exhaustion, never on an
  // intermediate retryable failure.
  await supabase
    .from("document_processing_jobs")
    .update({
      status: "exhausted",
      last_error: errorMessage,
      exhausted_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  await supabase
    .from("vendor_documents")
    .update({
      processing_status: "failed",
      processing_error: errorMessage,
      processed_at: new Date().toISOString(),
    })
    .eq("id", job.target_document_id);

  const { data: queueItem } = await supabase
    .from("compliance_queue_items")
    .select("id, state")
    .eq("document_id", job.target_document_id)
    .maybeSingle();
  if (queueItem && queueItem.state !== "resolved") {
    await supabase
      .from("compliance_queue_items")
      .update({ state: "in-review" })
      .eq("id", queueItem.id);
  }

  await notifyDocumentOutcome(supabase, resendApiKey, {
    companyId: job.company_id,
    vendorId: job.vendor_id,
    documentFileName: doc?.file_name ?? "the uploaded certificate",
    finalStatus: "failed",
    reviewReason: null,
    processingError: errorMessage,
  });

  return "exhausted";
}

Deno.serve(async (req: Request) => {
  const requestId = newRequestId();
  const route = "process-document-jobs";

  if (!isServiceRoleRequest(req)) {
    logOperational({
      level: "warn",
      event: "forbidden_caller",
      requestId,
      route,
      outcome: "failure",
    });
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }

  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!anthropicApiKey) {
    // Whole-run not_configured, matching retry-failed-documents/index.ts's
    // own reasoning: there is no point claiming a batch (which would mark
    // those rows 'processing' and burn an attempt) this run could not
    // possibly process anyway. Nothing here touches the queue, so once
    // ANTHROPIC_API_KEY is set the next minute's run picks up exactly where
    // this one left off.
    console.warn(
      "[process-document-jobs] ANTHROPIC_API_KEY is not set - skipping this run entirely.",
    );
    return new Response(
      JSON.stringify({ claimed: 0, succeeded: 0, failed: 0, exhausted: 0, notConfigured: true }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  const { data: claimedJobs, error: claimError } = await supabase.rpc(
    "claim_document_processing_jobs",
    { p_batch_size: BATCH_SIZE, p_claimed_by: requestId },
  );

  if (claimError) {
    logOperational(
      {
        level: "error",
        event: "claim_document_processing_jobs_failed",
        requestId,
        route,
        outcome: "failure",
        errorCode: "claim_error",
      },
      { message: claimError.message },
    );
    return new Response(JSON.stringify({ error: claimError.message }), { status: 500 });
  }

  const jobs = (claimedJobs ?? []) as ClaimedJob[];
  let succeeded = 0;
  let failed = 0;
  let exhausted = 0;

  for (const job of jobs) {
    let doc: { storage_path: string; mime_type: string; file_name: string } | null = null;
    try {
      const { data: docRow, error: docError } = await supabase
        .from("vendor_documents")
        .select("storage_path, mime_type, file_name")
        .eq("id", job.target_document_id)
        .maybeSingle();

      if (docError || !docRow) {
        const outcome = await recordJobFailure(
          supabase,
          resendApiKey,
          job,
          null,
          "The target document could not be found - it may have been deleted.",
        );
        if (outcome === "exhausted") exhausted++;
        else failed++;
        continue;
      }
      doc = docRow as { storage_path: string; mime_type: string; file_name: string };

      // Now using the column for what it was always meant for - see this
      // file's top docblock's backoff section.
      await supabase
        .from("vendor_documents")
        .update({ processing_status: "processing" })
        .eq("id", job.target_document_id);

      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from("vendor-documents")
        .download(doc.storage_path);

      if (downloadError || !fileBlob) {
        const outcome = await recordJobFailure(
          supabase,
          resendApiKey,
          job,
          doc,
          "Could not download the stored file for processing.",
        );
        if (outcome === "exhausted") exhausted++;
        else failed++;
        continue;
      }

      const fileBytes = await fileBlob.arrayBuffer();
      const extraction = await extractDocument(anthropic, fileBytes, doc.mime_type);

      if (extraction.status === "failed") {
        const outcome = await recordJobFailure(
          supabase,
          resendApiKey,
          job,
          doc,
          extraction.error ?? "Extraction failed.",
        );
        if (outcome === "exhausted") exhausted++;
        else failed++;
        continue;
      }

      const outcome = await finalizeSuccess(supabase, resendApiKey, job, doc, extraction);
      if (outcome === "succeeded") {
        succeeded++;
        logOperational({
          level: "info",
          event: "document_processing_job_succeeded",
          requestId,
          companyId: job.company_id,
          route,
          outcome: "success",
        });
      } else if (outcome === "exhausted") {
        exhausted++;
      } else {
        failed++;
      }
    } catch (error) {
      logOperational(
        {
          level: "error",
          event: "document_processing_job_unhandled_error",
          requestId,
          companyId: job.company_id,
          route,
          outcome: "failure",
          errorCode: error instanceof Error ? error.name : "unknown_error",
        },
        { message: error instanceof Error ? error.message : String(error) },
      );
      const outcome = await recordJobFailure(
        supabase,
        resendApiKey,
        job,
        doc,
        error instanceof Error ? error.message : "Unknown error during document processing",
      );
      if (outcome === "exhausted") exhausted++;
      else failed++;
    }
  }

  logOperational({
    level: exhausted > 0 ? "warn" : "info",
    event: "process_document_jobs_run_complete",
    requestId,
    route,
    outcome: "success",
  });

  return new Response(JSON.stringify({ claimed: jobs.length, succeeded, failed, exhausted }), {
    headers: { "Content-Type": "application/json" },
  });
});
