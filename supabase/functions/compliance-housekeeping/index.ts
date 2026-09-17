// @ts-nocheck - this file runs in Supabase's Deno Edge Runtime, not the app's
// Node/TypeScript project; its imports (jsr:, npm:) and Deno globals are not
// resolvable by the repo's own tsc/eslint config, which is why it is excluded
// there (see eslint.config.js) and verified instead by deploying it and
// invoking it against the live project (supabase/README.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  deficiencyEscalatedHtml,
  deficiencyEscalatedSubject,
  deficiencyEscalatedText,
  exceptionExpiredReopenedHtml,
  exceptionExpiredReopenedSubject,
  exceptionExpiredReopenedText,
} from "./emailTemplates.ts";
import { logOperational, newRequestId } from "./operationalLog.ts";

/**
 * Task 10b - the escalation/expiry half of Task 10 deliberately deferred out
 * of Task 10a's PR. Triggered daily by pg_cron -> pg_net (see
 * supabase/migrations/20260917001400_schedule_compliance_housekeeping.sql),
 * never by a user. Combines two independent "daily compliance housekeeping"
 * sweeps in one run rather than two near-identical Edge Functions:
 *
 *   1. compliance_deficiencies_due_for_escalation
 *      (20260917001300_compliance_case_escalation.sql) - open deficiencies
 *      whose correction request has crossed the next unfired 3/7/14-day
 *      threshold. For each: email the company's owner/risk_manager
 *      contacts, then call mark_deficiency_escalated() to advance
 *      escalation_level so the same threshold does not fire again tomorrow.
 *
 *   2. compliance_exceptions_due_for_reopening
 *      (20260917001300_compliance_case_escalation.sql) - approved exceptions
 *      past their expires_on whose deficiency is still waived. For each:
 *      call reopen_expired_compliance_exception() (reopens the deficiency,
 *      writes an audit_log row - this project's stand-in "task," see that
 *      function's own comment and supabase/README.md's Known compromises),
 *      then email the company's owner/risk_manager contacts that it
 *      happened.
 *
 * Runs on the service role: there is no signed-in user to run this as, and
 * it must see every company's due rows, not one tenant's.
 *
 * Not verify_jwt-gated at the platform level (deployed with verify_jwt:
 * false), same as retry-failed-documents/process-document-jobs - pg_net's
 * own POST carries the service-role JWT as its Authorization header, but
 * this function enforces that itself via isServiceRoleRequest() below
 * rather than relying on the platform gate, matching this project's other
 * cron-triggered functions exactly.
 *
 * Each due row is processed independently inside its own try/catch, same
 * resilience pattern retry-failed-documents/process-document-jobs already
 * use - one bad row (a failed send, an unexpected error) must not block
 * every other row in the batch.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
// Matches send-renewal-reminders/index.ts's FROM_ADDRESS exactly - see its
// own comment for why compliance.vendorclr.com, not the bare domain.
const FROM_ADDRESS = "VendorClr <onboarding@compliance.vendorclr.com>";

interface EscalationDueRow {
  deficiency_id: string;
  company_id: string;
  case_id: string;
  requirement_key: string;
  explanation: string;
  escalation_level: number;
  correction_requested_at: string;
  next_level: number;
  vendor_id: string;
  assignment_id: string;
  upload_request_id: string;
  vendor_name: string;
  vendor_contact_name: string;
  vendor_contact_email: string;
}

interface ReopeningDueRow {
  exception_id: string;
  company_id: string;
  deficiency_id: string;
  reason: string;
  expires_on: string;
  explanation: string;
  requirement_key: string;
  case_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_contact_name: string;
  vendor_contact_email: string;
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

/**
 * Native Deno reimplementation of fetchOwnerEmails() in
 * vendorUploadRequests.ts, widened to also include risk_manager - the
 * plan's own exception-approval bullet names both owner AND risk_manager as
 * compliance-relevant roles, and this notification is exactly the same
 * category of "a human must act" alert approve_compliance_exception()
 * itself gates on has_company_role(..., array['owner', 'risk_manager']).
 */
// deno-lint-ignore no-explicit-any
async function fetchComplianceContactEmails(supabase: any, companyId: string): Promise<string[]> {
  const { data: members } = await supabase
    .from("company_members")
    .select("user_id")
    .eq("company_id", companyId)
    .in("role", ["owner", "risk_manager"]);

  const userIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  if (userIds.length === 0) return [];

  const { data: profiles } = await supabase.from("profiles").select("email").in("id", userIds);
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

async function notifyComplianceContacts(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  resendApiKey: string | undefined,
  params: {
    companyId: string;
    vendorId: string;
    template: "compliance_deficiency_escalated" | "compliance_exception_expired";
    subject: string;
    html: string;
    text: string;
  },
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const contacts = await fetchComplianceContactEmails(supabase, params.companyId);

  for (const to of contacts) {
    const sendResult = await sendViaResend(resendApiKey, {
      to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
    await supabase.from("email_outbox").insert({
      company_id: params.companyId,
      vendor_id: params.vendorId,
      template: params.template,
      to_email: to,
      status:
        sendResult.status === "sent"
          ? "sent"
          : sendResult.status === "failed"
            ? "failed"
            : "queued",
      provider_message_id: sendResult.providerMessageId,
      error: sendResult.error,
      sent_at: sendResult.status === "sent" ? new Date().toISOString() : null,
    });
    if (sendResult.status === "sent") sent++;
    else if (sendResult.status === "failed") failed++;
  }

  return { sent, failed };
}

function daysSince(isoTimestamp: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((Date.now() - new Date(isoTimestamp).getTime()) / msPerDay));
}

Deno.serve(async (req: Request) => {
  const requestId = newRequestId();
  const route = "compliance-housekeeping";

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let escalated = 0;
  let escalationFailed = 0;
  let reopened = 0;
  let reopeningFailed = 0;

  // -------------------------------------------------------------------------
  // 1. Escalate unanswered correction requests.
  // -------------------------------------------------------------------------
  const { data: escalationDue, error: escalationDueError } = await supabase
    .from("compliance_deficiencies_due_for_escalation")
    .select(
      "deficiency_id, company_id, case_id, requirement_key, explanation, escalation_level, " +
        "correction_requested_at, next_level, vendor_id, assignment_id, upload_request_id, " +
        "vendor_name, vendor_contact_name, vendor_contact_email",
    );

  if (escalationDueError) {
    logOperational(
      {
        level: "error",
        event: "compliance_housekeeping_escalation_query_failed",
        requestId,
        route,
        outcome: "failure",
      },
      { message: escalationDueError.message },
    );
  }

  for (const row of (escalationDue ?? []) as EscalationDueRow[]) {
    try {
      const emailInput = {
        vendorName: row.vendor_name,
        requirementKey: row.requirement_key,
        explanation: row.explanation,
        nextLevel: row.next_level,
        daysSinceRequested: daysSince(row.correction_requested_at),
      };

      const { failed } = await notifyComplianceContacts(supabase, resendApiKey, {
        companyId: row.company_id,
        vendorId: row.vendor_id,
        template: "compliance_deficiency_escalated",
        subject: deficiencyEscalatedSubject(emailInput),
        html: deficiencyEscalatedHtml(emailInput),
        text: deficiencyEscalatedText(emailInput),
      });

      // Advance escalation_level regardless of send outcome (contacts may be
      // empty, or every send may fail): the live-status-recheck inside
      // mark_deficiency_escalated() is what actually protects correctness
      // (never touches a deficiency that stopped being open), and refusing
      // to advance on a send failure would mean the SAME threshold re-fires
      // every day forever rather than moving on to the next one, which is
      // strictly worse than a single missed notification.
      const { error: markError } = await supabase.rpc("mark_deficiency_escalated", {
        p_deficiency_id: row.deficiency_id,
        p_new_level: row.next_level,
      });
      if (markError) throw new Error(markError.message);

      if (failed > 0) {
        escalationFailed++;
      } else {
        escalated++;
        logOperational({
          level: "info",
          event: "compliance_deficiency_escalated",
          requestId,
          companyId: row.company_id,
          route,
          outcome: "success",
        });
      }
    } catch (error) {
      escalationFailed++;
      logOperational(
        {
          level: "error",
          event: "compliance_deficiency_escalation_unhandled_error",
          requestId,
          companyId: row.company_id,
          route,
          outcome: "failure",
          errorCode: error instanceof Error ? error.name : "unknown_error",
        },
        { message: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. Reopen deficiencies behind an expired exception.
  // -------------------------------------------------------------------------
  const { data: reopeningDue, error: reopeningDueError } = await supabase
    .from("compliance_exceptions_due_for_reopening")
    .select(
      "exception_id, company_id, deficiency_id, reason, expires_on, explanation, " +
        "requirement_key, case_id, vendor_id, vendor_name, vendor_contact_name, vendor_contact_email",
    );

  if (reopeningDueError) {
    logOperational(
      {
        level: "error",
        event: "compliance_housekeeping_reopening_query_failed",
        requestId,
        route,
        outcome: "failure",
      },
      { message: reopeningDueError.message },
    );
  }

  for (const row of (reopeningDue ?? []) as ReopeningDueRow[]) {
    try {
      const { error: reopenError } = await supabase.rpc("reopen_expired_compliance_exception", {
        p_exception_id: row.exception_id,
      });
      if (reopenError) throw new Error(reopenError.message);

      const emailInput = {
        vendorName: row.vendor_name,
        requirementKey: row.requirement_key,
        explanation: row.explanation,
        exceptionReason: row.reason,
        expiresOn: row.expires_on,
      };

      const { failed } = await notifyComplianceContacts(supabase, resendApiKey, {
        companyId: row.company_id,
        vendorId: row.vendor_id,
        template: "compliance_exception_expired",
        subject: exceptionExpiredReopenedSubject(emailInput),
        html: exceptionExpiredReopenedHtml(emailInput),
        text: exceptionExpiredReopenedText(emailInput),
      });

      if (failed > 0) {
        reopeningFailed++;
      } else {
        reopened++;
        logOperational({
          level: "info",
          event: "compliance_exception_expired_reopened",
          requestId,
          companyId: row.company_id,
          route,
          outcome: "success",
        });
      }
    } catch (error) {
      reopeningFailed++;
      logOperational(
        {
          level: "error",
          event: "compliance_exception_reopening_unhandled_error",
          requestId,
          companyId: row.company_id,
          route,
          outcome: "failure",
          errorCode: error instanceof Error ? error.name : "unknown_error",
        },
        { message: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  logOperational({
    level: escalationFailed > 0 || reopeningFailed > 0 ? "warn" : "info",
    event: "compliance_housekeeping_run_complete",
    requestId,
    route,
    outcome: "success",
  });

  return new Response(
    JSON.stringify({
      escalated,
      escalationFailed,
      reopened,
      reopeningFailed,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
