import { createServerFn } from "@tanstack/react-start";

/**
 * Lives in src/workflows/, not src/server/ as the Task 2 plan's file list
 * names it: this project's Vite config (@lovable.dev/vite-tanstack-config)
 * hard-codes `importProtection.client.files: ["**\/server/**"]` - ANY file
 * matching that glob is unconditionally denied from the client bundle,
 * regardless of createServerFn wrapping (confirmed empirically: `bun run
 * build` failed with "Denied by file pattern: **\/server/**" when this file
 * lived at src/server/operations.ts and was imported, as it must be, from
 * OperationsPage.tsx - a client component). src/workflows/ is this
 * codebase's actual, already-working home for client-callable
 * createServerFn modules (vendorUploadRequests.ts, documentReview.ts), so
 * this follows that real convention instead of the plan's literal path.
 *
 * Loaded lazily inside the handler, not statically imported: this file is
 * imported by OperationsPage.tsx (a client component), and a static import
 * of a *.server module would put it in the client bundle's import graph -
 * the same reasoning vendorUploadRequests.ts documents for its own lazy
 * getServiceRoleClient()/getRequestScopedClient() wrappers, and the exact
 * pattern this file reuses.
 */
async function getServiceRoleClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getServiceRoleClient();
}

/**
 * getOperationalFailures() - the internal operations screen's one data
 * source: failed/exhausted extraction jobs, stale review items, bounced/
 * complained email, malware unknown/error, scheduled-job run health and the
 * oldest open queue item, plus currently-firing alerts for all six
 * conditions in Task 2's checklist.
 *
 * Every read here runs on the SERVICE ROLE, after assertPlatformAdmin() (the
 * same function reprocessDocument()/documentReview.ts already use, imported
 * rather than re-implemented) independently re-validates the caller via
 * RLS/auth.uid() first. This is staff-only, cross-tenant-by-design data (an
 * admin needs to see every company's failures, not just one) - exactly the
 * "can_write_company() would never grant this, and RLS's company-membership
 * model was never meant to" situation assertPlatformAdmin()'s own docblock
 * describes for reprocessDocument(). Three of the six signals below
 * (compliance_queue_items, vendor_documents, email_delivery_events) do
 * already carry an `or public.is_platform_admin()` RLS clause and would
 * technically return the same cross-tenant rows through the request-scoped
 * client - but cron.job_run_details/cron.job (system catalogs, no RLS at
 * all) and pg_database_size() do not go through RLS in any form, so this
 * function uses the service-role client uniformly for all six rather than
 * splitting the query path by table.
 *
 * No new table, no new migration for any of this (deliberate - see the
 * Task 2 plan): every signal is read from tables/views/system catalogs that
 * already exist. The one exception is a read-only grant
 * (20260917000100_operations_cron_grants.sql) - service_role had no SELECT
 * on cron.job/cron.job_run_details at all before this task; confirmed
 * missing live, not assumed (see that migration's own docblock).
 */

// ---------------------------------------------------------------------------
// Named thresholds - every magic number here has a name, per the plan.
// ---------------------------------------------------------------------------

/** documents_due_for_retry (20260903000300_automated_retry_queue.sql) stops surfacing a document once retry_count reaches this - "exhausted" means it hit that cap while still `failed`. */
export const RETRY_CAP = 5;

/** A `compliance_queue_items` row not yet `resolved` and older than this counts as "stale" for the operations page. Not defined by the schema itself - a reasonable, named default rather than a bare number scattered through queries. */
export const STALE_REVIEW_THRESHOLD_HOURS = 48;

/** Window `evaluateExtractionFailureRateAlert()` is fed over, per the plan's alert checklist ("extraction failure >5% over 30 minutes"). */
export const EXTRACTION_FAILURE_WINDOW_MINUTES = 30;

/** Window `evaluateBounceRateAlert()` is fed over, per the plan's alert checklist ("bounce >5% over 24 hours"). */
export const BOUNCE_WINDOW_HOURS = 24;

/**
 * Placeholder only - this session has no access to the real Supabase plan's
 * storage quota via any available tool (get_project/get_cost do not expose
 * it). 8 GiB approximates a small hosted Postgres plan; a human must tune
 * this against the project's actual plan limit before the storage-capacity
 * alert means anything real. Named and documented here specifically so it is
 * never mistaken for an authoritative number.
 */
export const STORAGE_CAPACITY_PLACEHOLDER_BYTES = 8 * 1024 * 1024 * 1024;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Alert conditions - pure, unit-tested (src/tests/operations.test.tsx)
// functions per the plan's six conditions. Each takes exactly the numbers/
// history it needs to decide, independent of how getOperationalFailures()
// below happens to gather them - so a future real-monitoring source (e.g. a
// cron-based readiness prober persisting its own history, which this task
// deliberately does not build - no new table) can feed these unchanged.
// ---------------------------------------------------------------------------

export type AlertSeverity = "warning" | "critical";

export interface AlertState {
  key: string;
  firing: boolean;
  severity: AlertSeverity;
  message: string;
}

/**
 * 1. Readiness down for 5 minutes.
 *
 * Takes "how long has readiness been continuously failing" as a single
 * value the caller computes, rather than a history array, because this
 * task's Task 2 scope has no persistent store for readiness-check history
 * (no new migration/table) - getOperationalFailures() below can only ever
 * observe a single instant, so it passes 0 (not currently failing) or the
 * time since its own current check started failing, which can never exceed
 * one invocation's duration. A future scheduled readiness-prober that
 * persists its own check history would compute the real sustained-duration
 * value and pass it here unchanged - this function does not care where the
 * number came from.
 */
export function evaluateReadinessAlert(params: {
  continuousFailureDurationMs: number;
}): AlertState {
  const firing = params.continuousFailureDurationMs >= 5 * MINUTE_MS;
  return {
    key: "readiness_down_5m",
    firing,
    severity: "critical",
    message: firing
      ? `/api/health/ready has been failing for ${Math.round(params.continuousFailureDurationMs / MINUTE_MS)} minute(s).`
      : "Readiness is currently healthy.",
  };
}

/**
 * 2. A scheduled job missed twice - its two most recent runs (per
 * cron.job_run_details, newest first) both came back something other than
 * 'succeeded'. Fewer than two recorded runs never fires (nothing to call a
 * pattern yet).
 */
export function evaluateMissedScheduledJobAlert(params: {
  jobName: string;
  recentRuns: Array<{ status: string; startedAt: Date }>;
}): AlertState {
  const [mostRecent, secondMostRecent] = params.recentRuns;
  const firing =
    mostRecent !== undefined &&
    secondMostRecent !== undefined &&
    mostRecent.status !== "succeeded" &&
    secondMostRecent.status !== "succeeded";

  return {
    key: `scheduled_job_missed_twice:${params.jobName}`,
    firing,
    severity: "critical",
    message: firing
      ? `${params.jobName}'s last two runs both failed (${mostRecent.status}, ${secondMostRecent.status}).`
      : `${params.jobName} is running normally.`,
  };
}

/** 3. Extraction failure rate over the 30-minute window - firing above 5%. Zero attempts in the window never fires (nothing to divide by, not evidence of a problem). */
export function evaluateExtractionFailureRateAlert(params: {
  totalProcessed: number;
  totalFailed: number;
}): AlertState {
  const rate = params.totalProcessed > 0 ? params.totalFailed / params.totalProcessed : 0;
  const firing = params.totalProcessed > 0 && rate > 0.05;
  return {
    key: "extraction_failure_rate",
    firing,
    severity: "warning",
    message: firing
      ? `${params.totalFailed}/${params.totalProcessed} extractions failed in the last ${EXTRACTION_FAILURE_WINDOW_MINUTES} minutes (${Math.round(rate * 100)}%).`
      : "Extraction failure rate is within normal range.",
  };
}

/** 4. Any document that has exhausted its automated retry budget (retry_count >= RETRY_CAP, still `failed`) - fires on any count above zero, no rate threshold. */
export function evaluateExhaustedRetryAlert(params: { exhaustedCount: number }): AlertState {
  const firing = params.exhaustedCount > 0;
  return {
    key: "exhausted_retry",
    firing,
    severity: "warning",
    message: firing
      ? `${params.exhaustedCount} document(s) exhausted all ${RETRY_CAP} automated retry attempts and need a human look.`
      : "No documents have exhausted their automated retry budget.",
  };
}

/** 5. Bounce/complaint rate over the 24-hour window - firing above 5%. Zero sends in the window never fires. */
export function evaluateBounceRateAlert(params: {
  totalSent: number;
  totalBounced: number;
}): AlertState {
  const rate = params.totalSent > 0 ? params.totalBounced / params.totalSent : 0;
  const firing = params.totalSent > 0 && rate > 0.05;
  return {
    key: "bounce_rate",
    firing,
    severity: "warning",
    message: firing
      ? `${params.totalBounced}/${params.totalSent} emails bounced or were marked spam in the last ${BOUNCE_WINDOW_HOURS} hours (${Math.round(rate * 100)}%).`
      : "Bounce/complaint rate is within normal range.",
  };
}

/** 6. Storage/database capacity over 80%, against STORAGE_CAPACITY_PLACEHOLDER_BYTES (or a caller-supplied real quota once one is known). */
export function evaluateStorageCapacityAlert(params: {
  usedBytes: number;
  capacityBytes: number;
}): AlertState {
  const ratio = params.capacityBytes > 0 ? params.usedBytes / params.capacityBytes : 0;
  const firing = params.capacityBytes > 0 && ratio > 0.8;
  return {
    key: "storage_capacity",
    firing,
    severity: "critical",
    message: firing
      ? `Database is at ${Math.round(ratio * 100)}% of its ${Math.round(params.capacityBytes / (1024 * 1024 * 1024))} GiB placeholder capacity.`
      : "Database storage is within normal range.",
  };
}

/**
 * The alert-delivery seam. No real provider (Slack/PagerDuty/email-to-
 * oncall) is configured in this session or wired here - out of scope for
 * this task, per the plan's own scope boundary. This no-ops (logging only)
 * when unconfigured, the same "detect unconfigured, skip gracefully"
 * convention as every optional integration in this project
 * (getEmailSender()/getDocumentExtractor()/getMalwareScanner()).
 * VITE_ALERT_WEBHOOK_URL is not set anywhere in this repo; when a future
 * task sets it to a real Slack/PagerDuty webhook URL, this starts actually
 * delivering with no other code change.
 */
export async function notifyAlert(alert: AlertState): Promise<void> {
  if (!alert.firing) return;

  const webhookUrl = (import.meta.env["VITE_ALERT_WEBHOOK_URL"] as string | undefined)?.trim();
  const { logOperational, newRequestId } = await import("@/lib/observability/logger.server");

  if (!webhookUrl) {
    logOperational({
      level: "warn",
      event: "alert_fired_no_provider_configured",
      requestId: newRequestId(),
      outcome: "failure",
      errorCode: alert.key,
    });
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: alert.key, severity: alert.severity, message: alert.message }),
    });
  } catch {
    // Never let alert delivery itself become a second failure.
  }
}

// ---------------------------------------------------------------------------
// getOperationalFailures() - the server function OperationsPage.tsx calls.
// ---------------------------------------------------------------------------

export interface FailedExtractionJob {
  documentId: string;
  companyId: string;
  vendorId: string;
  fileName: string;
  retryCount: number;
  exhausted: boolean;
  processingError: string | null;
}

export interface StaleReviewItem {
  queueItemId: string;
  companyId: string;
  vendorId: string;
  documentLabel: string;
  state: string;
  submittedOn: string;
  ageHours: number;
}

export interface BouncedEmailEvent {
  id: string;
  companyId: string;
  emailOutboxId: string;
  eventType: string;
  occurredAt: string;
}

export interface MalwareFlaggedDocument {
  documentId: string;
  companyId: string;
  vendorId: string;
  fileName: string;
  malwareScanStatus: string;
}

export interface ScheduledJobHealth {
  jobName: string;
  recentRuns: Array<{ status: string; startedAt: string }>;
  alert: AlertState;
}

export interface OperationalFailuresSummary {
  generatedAt: string;
  failedExtractionJobs: FailedExtractionJob[];
  staleReviewItems: StaleReviewItem[];
  bouncedEmail: BouncedEmailEvent[];
  malwareFlagged: MalwareFlaggedDocument[];
  scheduledJobs: ScheduledJobHealth[];
  oldestQueueAgeHours: number | null;
  storage: { usedBytes: number; capacityBytes: number };
  alerts: AlertState[];
}

/** Shape returned by public.get_scheduled_job_run_history() - `cron.job_run_details.status` values include 'succeeded', 'failed', 'running', 'starting'. */
export interface CronJobRunRow {
  job_name: string;
  status: string;
  start_time: string;
}

export const getOperationalFailures = createServerFn({ method: "GET" }).handler(
  async (): Promise<OperationalFailuresSummary> => {
    const { assertPlatformAdmin } = await import("@/workflows/vendorUploadRequests");
    const { logOperational, newRequestId, withOperationalLog } =
      await import("@/lib/observability/logger.server");
    const requestId = newRequestId();

    return withOperationalLog(
      {
        level: "info",
        event: "get_operational_failures",
        requestId,
        route: "/dashboard/admin/operations",
      },
      async () => {
        const actorId = await assertPlatformAdmin();
        const supabase = await getServiceRoleClient();
        const now = new Date();

        const staleReviewCutoff = new Date(
          now.getTime() - STALE_REVIEW_THRESHOLD_HOURS * HOUR_MS,
        ).toISOString();
        const extractionWindowStart = new Date(
          now.getTime() - EXTRACTION_FAILURE_WINDOW_MINUTES * MINUTE_MS,
        ).toISOString();
        const bounceWindowStart = new Date(
          now.getTime() - BOUNCE_WINDOW_HOURS * HOUR_MS,
        ).toISOString();

        const [
          failedDocsResult,
          staleQueueResult,
          bouncedResult,
          malwareResult,
          extractionWindowResult,
          bounceWindowSentResult,
          cronRunsResult,
          oldestQueueResult,
          dbSizeResult,
        ] = await Promise.all([
          supabase
            .from("vendor_documents")
            .select("id, company_id, vendor_id, file_name, retry_count, processing_error")
            .eq("processing_status", "failed"),
          supabase
            .from("compliance_queue_items")
            .select("id, company_id, vendor_id, document_label, state, submitted_on")
            .neq("state", "resolved")
            .lte("submitted_on", staleReviewCutoff),
          supabase
            .from("email_delivery_events")
            .select("id, company_id, email_outbox_id, event_type, occurred_at")
            .in("event_type", ["bounced", "complained"])
            .order("occurred_at", { ascending: false })
            .limit(50),
          // Task 3 (Engineer A): "unknown"/"not_configured"/"error" are all
          // visible-but-not-clean scan states per that task's own checklist
          // ("treat unknown, not_configured, and error as visible
          // review/operations states, not clean") - a document that was
          // never actually scanned (VIRUSTOTAL_API_KEY unset) is exactly as
          // worth an operator's attention as one VirusTotal has never
          // analyzed or one whose scan call itself failed. Only "clean"
          // (analyzed, zero engines flagged it) and "malicious" (already
          // blocked outright at upload time - see uploadDocumentForToken())
          // are excluded here.
          supabase
            .from("vendor_documents")
            .select("id, company_id, vendor_id, file_name, malware_scan_status")
            .in("malware_scan_status", ["unknown", "not_configured", "error"]),
          supabase
            .from("vendor_documents")
            .select("processing_status")
            .not("processed_at", "is", null)
            .gte("processed_at", extractionWindowStart),
          supabase
            .from("email_delivery_events")
            .select("event_type")
            .gte("occurred_at", bounceWindowStart),
          // cron.job/cron.job_run_details are not `public`-schema tables
          // PostgREST can serve directly - get_scheduled_job_run_history()
          // (20260917000200_operations_scheduled_job_functions.sql) is a
          // narrow public-schema wrapper function, callable via .rpc(),
          // that reads them on service_role's behalf using the read grants
          // from 20260917000100_operations_cron_grants.sql. Returns the 200
          // most recent finished runs across every job, newest first -
          // grouped per job and truncated to 2 below, which is all
          // evaluateMissedScheduledJobAlert() looks at.
          supabase.rpc("get_scheduled_job_run_history"),
          supabase
            .from("compliance_queue_items")
            .select("submitted_on")
            .neq("state", "resolved")
            .order("submitted_on", { ascending: true })
            .limit(1),
          // pg_database_size() lives in pg_catalog, same reasoning -
          // get_database_size_bytes() is the public-schema wrapper.
          supabase.rpc("get_database_size_bytes"),
        ]);

        const cronJobs = groupCronRunsByJob((cronRunsResult.data ?? []) as CronJobRunRow[]);
        // PostgREST serializes a `bigint` return as a JSON number when it
        // fits in a safe integer (true for any realistic database size);
        // Number() defensively also covers the rarer string encoding.
        const usedBytes = Number(dbSizeResult.data ?? 0) || 0;

        const failedExtractionJobs: FailedExtractionJob[] = (failedDocsResult.data ?? []).map(
          (row) => ({
            documentId: row.id as string,
            companyId: row.company_id as string,
            vendorId: row.vendor_id as string,
            fileName: row.file_name as string,
            retryCount: row.retry_count as number,
            exhausted: (row.retry_count as number) >= RETRY_CAP,
            processingError: row.processing_error as string | null,
          }),
        );

        const staleReviewItems: StaleReviewItem[] = (staleQueueResult.data ?? []).map((row) => {
          const submittedOn = row.submitted_on as string;
          const ageHours = (now.getTime() - new Date(submittedOn).getTime()) / HOUR_MS;
          return {
            queueItemId: row.id as string,
            companyId: row.company_id as string,
            vendorId: row.vendor_id as string,
            documentLabel: row.document_label as string,
            state: row.state as string,
            submittedOn,
            ageHours: Math.round(ageHours),
          };
        });

        const bouncedEmail: BouncedEmailEvent[] = (bouncedResult.data ?? []).map((row) => ({
          id: row.id as string,
          companyId: row.company_id as string,
          emailOutboxId: row.email_outbox_id as string,
          eventType: row.event_type as string,
          occurredAt: row.occurred_at as string,
        }));

        const malwareFlagged: MalwareFlaggedDocument[] = (malwareResult.data ?? []).map((row) => ({
          documentId: row.id as string,
          companyId: row.company_id as string,
          vendorId: row.vendor_id as string,
          fileName: row.file_name as string,
          malwareScanStatus: row.malware_scan_status as string,
        }));

        const extractionRows = (extractionWindowResult.data ?? []) as Array<{
          processing_status: string;
        }>;
        const totalProcessed = extractionRows.length;
        const totalFailed = extractionRows.filter((r) => r.processing_status === "failed").length;

        const bounceWindowRows = (bounceWindowSentResult.data ?? []) as Array<{
          event_type: string;
        }>;
        const totalSent = bounceWindowRows.length;
        const totalBounced = bounceWindowRows.filter(
          (r) => r.event_type === "bounced" || r.event_type === "complained",
        ).length;

        const oldestSubmittedOn = (oldestQueueResult.data ?? [])[0]?.submitted_on as
          string | undefined;
        const oldestQueueAgeHours = oldestSubmittedOn
          ? Math.round((now.getTime() - new Date(oldestSubmittedOn).getTime()) / HOUR_MS)
          : null;

        const exhaustedCount = failedExtractionJobs.filter((d) => d.exhausted).length;

        const scheduledJobs: ScheduledJobHealth[] = cronJobs.map((job) => ({
          jobName: job.jobName,
          recentRuns: job.recentRuns.map((r) => ({
            status: r.status,
            startedAt: r.startedAt.toISOString(),
          })),
          alert: evaluateMissedScheduledJobAlert({
            jobName: job.jobName,
            recentRuns: job.recentRuns,
          }),
        }));

        const alerts: AlertState[] = [
          // Single-instant proxy only - see evaluateReadinessAlert()'s own
          // docblock. This call succeeding at all means Supabase answered
          // just now, so there is no sustained failure to report from here.
          evaluateReadinessAlert({ continuousFailureDurationMs: 0 }),
          ...scheduledJobs.map((j) => j.alert),
          evaluateExtractionFailureRateAlert({ totalProcessed, totalFailed }),
          evaluateExhaustedRetryAlert({ exhaustedCount }),
          evaluateBounceRateAlert({ totalSent, totalBounced }),
          evaluateStorageCapacityAlert({
            usedBytes,
            capacityBytes: STORAGE_CAPACITY_PLACEHOLDER_BYTES,
          }),
        ];

        await Promise.all(alerts.filter((a) => a.firing).map((a) => notifyAlert(a)));

        logOperational({
          level: "info",
          event: "operational_failures_read",
          requestId,
          actorId,
          route: "/dashboard/admin/operations",
          outcome: "success",
        });

        return {
          generatedAt: now.toISOString(),
          failedExtractionJobs,
          staleReviewItems,
          bouncedEmail,
          malwareFlagged,
          scheduledJobs,
          oldestQueueAgeHours,
          storage: { usedBytes, capacityBytes: STORAGE_CAPACITY_PLACEHOLDER_BYTES },
          alerts,
        };
      },
    );
  },
);

/**
 * get_scheduled_job_run_history() (see that function's own migration
 * docblock) returns a flat, newest-first list across every job. Pure and
 * exported for testing: groups by job name and keeps each job's runs in
 * the order the function already returned them (newest first) so
 * evaluateMissedScheduledJobAlert() can look at exactly the first two
 * entries of each job's list.
 */
export function groupCronRunsByJob(
  rows: CronJobRunRow[],
): Array<{ jobName: string; recentRuns: Array<{ status: string; startedAt: Date }> }> {
  const byJob = new Map<string, Array<{ status: string; startedAt: Date }>>();
  for (const row of rows) {
    const run = { status: row.status, startedAt: new Date(row.start_time) };
    const existing = byJob.get(row.job_name);
    if (existing) existing.push(run);
    else byJob.set(row.job_name, [run]);
  }
  return Array.from(byJob.entries()).map(([jobName, recentRuns]) => ({ jobName, recentRuns }));
}
