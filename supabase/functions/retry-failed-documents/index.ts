// @ts-nocheck - this file runs in Supabase's Deno Edge Runtime, not the app's
// Node/TypeScript project; its imports (jsr:, npm:) and Deno globals are not
// resolvable by the repo's own tsc/eslint config, which is why it is excluded
// there (see eslint.config.js) and verified instead by deploying it and
// invoking it against the live project (supabase/README.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.122.0";

import { extractDocument } from "./documentExtraction.ts";

/**
 * Triggered hourly by pg_cron -> pg_net (see
 * supabase/migrations/20260903000400_schedule_automated_retries.sql), never
 * by a user. Reads public.documents_due_for_retry (migration 17 - already
 * excludes anything past the retry cap, still on backoff cooldown, or whose
 * queue item a human already resolved) and re-runs extraction for each.
 *
 * Deliberately conservative: a successful re-extraction is ALWAYS written
 * as needs_review, never processed - this function does not port
 * applyComplianceEngine()'s matching/vendor_policies-writing logic to Deno
 * (a much bigger duplication than the small, pure-function ports alongside
 * this file). Recovering the DATA automatically and letting a human decide
 * through the review screen (documentReview.ts, already built) is the
 * whole job here; auto-applying it is not. See migration 17's docblock for
 * the full reasoning, including why a document whose queue item is already
 * 'resolved' is excluded before this even runs.
 *
 * A failed attempt increments retry_count and schedules the next one with
 * widening backoff (1h, 4h, 12h, 24h, 48h) - see BACKOFF_HOURS_BY_ATTEMPT.
 * After 5 attempts documents_due_for_retry stops surfacing the document at
 * all; a person can still retry it any time via reprocessDocument(), which
 * does not check or touch this cap - see migration 17.
 *
 * Runs on the service role: there is no signed-in user to run this as, and
 * it must see every company's due documents, not one tenant's.
 */

const MAX_AUTO_RETRIES = 5;
const BACKOFF_HOURS_BY_ATTEMPT = [1, 4, 12, 24, 48];

interface DueRow {
  document_id: string;
  company_id: string;
  vendor_id: string;
  storage_path: string;
  mime_type: string;
  file_name: string;
  retry_count: number;
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

async function recordFailedAttempt(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  row: DueRow,
  errorMessage: string,
): Promise<void> {
  const newRetryCount = row.retry_count + 1;
  const backoffHours = BACKOFF_HOURS_BY_ATTEMPT[Math.min(newRetryCount, MAX_AUTO_RETRIES) - 1];
  const nextRetryAt = new Date(Date.now() + backoffHours * 60 * 60 * 1000).toISOString();

  await supabase
    .from("vendor_documents")
    .update({
      retry_count: newRetryCount,
      next_retry_at: nextRetryAt,
      processing_error: errorMessage,
    })
    .eq("id", row.document_id);
}

Deno.serve(async (req: Request) => {
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }

  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!anthropicApiKey) {
    // Whole-run not_configured rather than a per-document result: there is
    // no point spending a DB round trip finding due documents this run
    // could not possibly process anyway. Nothing here touches retry_count,
    // so once ANTHROPIC_API_KEY is set the next hourly run picks up exactly
    // where this one left off.
    console.warn(
      "[retry-failed-documents] ANTHROPIC_API_KEY is not set - skipping this run entirely.",
    );
    return new Response(
      JSON.stringify({ processed: 0, succeeded: 0, failed: 0, notConfigured: true }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  const { data: due, error: dueError } = await supabase
    .from("documents_due_for_retry")
    .select("document_id, company_id, vendor_id, storage_path, mime_type, file_name, retry_count");

  if (dueError) {
    return new Response(JSON.stringify({ error: dueError.message }), { status: 500 });
  }

  const dueRows = (due ?? []) as DueRow[];
  let succeeded = 0;
  let failed = 0;

  for (const row of dueRows) {
    try {
      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from("vendor-documents")
        .download(row.storage_path);

      if (downloadError || !fileBlob) {
        await recordFailedAttempt(supabase, row, "Could not download the stored file for retry.");
        failed++;
        continue;
      }

      const fileBytes = await fileBlob.arrayBuffer();
      const extraction = await extractDocument(anthropic, fileBytes, row.mime_type);

      if (extraction.status === "failed") {
        await recordFailedAttempt(supabase, row, extraction.error ?? "Extraction failed.");
        failed++;
        continue;
      }

      // Always needs_review, never processed - see this function's docblock.
      await supabase
        .from("vendor_documents")
        .update({
          processing_status: "needs_review",
          parsed_data: extraction.data,
          extraction_confidence: extraction.confidence,
          processing_error: null,
          review_reason: "Recovered by an automated retry - awaiting review.",
          processed_at: new Date().toISOString(),
        })
        .eq("id", row.document_id);

      const { data: queueItem } = await supabase
        .from("compliance_queue_items")
        .select("id, state")
        .eq("document_id", row.document_id)
        .maybeSingle();

      // Only nudges an open item back into view - documents_due_for_retry
      // already excluded a resolved one before this loop ever started, so
      // queueItem.state should never be 'resolved' here; the check is
      // defensive, not load-bearing.
      if (queueItem && queueItem.state !== "resolved") {
        await supabase
          .from("compliance_queue_items")
          .update({ state: "in-review" })
          .eq("id", queueItem.id);
      }

      succeeded++;
    } catch (error) {
      console.error(
        `[retry-failed-documents] unhandled error for document ${row.document_id}:`,
        error,
      );
      await recordFailedAttempt(
        supabase,
        row,
        error instanceof Error ? error.message : "Unknown error during automated retry",
      );
      failed++;
    }
  }

  return new Response(JSON.stringify({ processed: dueRows.length, succeeded, failed }), {
    headers: { "Content-Type": "application/json" },
  });
});
