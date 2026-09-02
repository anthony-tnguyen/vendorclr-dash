// @ts-nocheck - this file runs in Supabase's Deno Edge Runtime, not the app's
// Node/TypeScript project; its imports (jsr:, npm:) and Deno globals are not
// resolvable by the repo's own tsc/eslint config, which is why it is excluded
// there (see eslint.config.js / tsconfig.json) and verified instead by
// deploying it and invoking it against the live project (supabase/README.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { renewalReminderHtml, renewalReminderSubject, renewalReminderText } from "./emailTemplates.ts";
import { generateUploadToken, hashToken, newExpiryDate } from "./uploadTokens.ts";

/**
 * Triggered daily by pg_cron -> pg_net (see
 * supabase/migrations/20260902000600_schedule_renewal_reminders.sql), never
 * by a user. It:
 *
 *   1. Reads public.policies_due_for_reminder (the view already excludes
 *      anything already logged for its current threshold - see migration
 *      10's docblock).
 *   2. For each due policy, creates a fresh vendor_upload_requests row and
 *      magic-link token, the same shape createUploadRequest() in
 *      src/workflows/vendorUploadRequests.ts creates for a manually-triggered
 *      request.
 *   3. Emails the vendor via Resend, or logs a stub result if RESEND_API_KEY
 *      is not set - never throws for a missing provider, matching
 *      getEmailSender()'s behavior in the Node app.
 *   4. Only on a successful send, writes policy_reminder_log so this
 *      threshold does not fire again for this policy. A failed or
 *      not-configured send is deliberately left unlogged so tomorrow's run
 *      retries it - the log's job is to prevent double-SENDING, not to mark a
 *      threshold "handled" when nothing went out.
 *
 * Runs on the service role: there is no signed-in user to run this as, and
 * it must see every company's due policies, not one tenant's.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM_ADDRESS = "VendorClear <onboarding@vendorclear.app>";

interface DueRow {
  policy_id: string;
  vendor_id: string;
  company_id: string;
  expiration_date: string;
  days_threshold: number;
}

interface VendorRow {
  id: string;
  name: string;
  contact_name: string;
  contact_email: string;
  company_id: string;
  companies: { name: string } | null;
}

interface PolicyRow {
  id: string;
  carrier_name: string;
  policy_number: string;
}

function bareAppUrl(): string {
  const configured = Deno.env.get("APP_URL")?.trim();
  return (configured || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Defense in depth on top of the platform's own verify_jwt check: this
 * function should only ever be invoked by pg_net carrying the service-role
 * key, never by a signed-in dashboard user's own session. Parses the JWT
 * payload without re-verifying the signature - the platform already did
 * that before this code ran - just to confirm which role it was issued for.
 */
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

function daysUntil(expirationDate: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const expiry = new Date(expirationDate);
  const expiryUtc = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
  return Math.round((expiryUtc - todayUtc) / msPerDay);
}

Deno.serve(async (req: Request) => {
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: due, error: dueError } = await supabase
    .from("policies_due_for_reminder")
    .select("policy_id, vendor_id, company_id, expiration_date, days_threshold");

  if (dueError) {
    return new Response(JSON.stringify({ error: dueError.message }), { status: 500 });
  }

  const dueRows = (due ?? []) as DueRow[];
  if (dueRows.length === 0) {
    return new Response(
      JSON.stringify({ processed: 0, sent: 0, failed: 0, notConfigured: 0, skipped: 0 }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const vendorIds = [...new Set(dueRows.map((r) => r.vendor_id))];
  const policyIds = [...new Set(dueRows.map((r) => r.policy_id))];

  const [{ data: vendors, error: vendorsError }, { data: policies, error: policiesError }] =
    await Promise.all([
      supabase
        .from("vendors")
        .select("id, name, contact_name, contact_email, company_id, companies ( name )")
        .in("id", vendorIds),
      supabase.from("vendor_policies").select("id, carrier_name, policy_number").in("id", policyIds),
    ]);

  if (vendorsError || policiesError) {
    return new Response(
      JSON.stringify({ error: vendorsError?.message ?? policiesError?.message }),
      { status: 500 },
    );
  }

  const vendorById = new Map(((vendors ?? []) as unknown as VendorRow[]).map((v) => [v.id, v]));
  const policyById = new Map(((policies ?? []) as PolicyRow[]).map((p) => [p.id, p]));

  let sent = 0;
  let failed = 0;
  let notConfigured = 0;
  let skipped = 0;

  for (const row of dueRows) {
    try {
      const vendor = vendorById.get(row.vendor_id);
      const policy = policyById.get(row.policy_id);

      if (!vendor || !policy || !vendor.contact_email) {
        skipped++;
        continue;
      }

      const token = generateUploadToken();
      const tokenHash = await hashToken(token);
      const expiresAt = newExpiryDate();

      const { data: request, error: insertError } = await supabase
        .from("vendor_upload_requests")
        .insert({
          company_id: row.company_id,
          vendor_id: row.vendor_id,
          token_hash: tokenHash,
          purpose: "renewal",
          expires_at: expiresAt.toISOString(),
        })
        .select("id")
        .single();

      if (insertError || !request) {
        failed++;
        continue;
      }

      const uploadUrl = `${bareAppUrl()}/vendor-upload/${token}`;
      const emailInput = {
        vendorContactName: vendor.contact_name,
        vendorName: vendor.name,
        companyName: vendor.companies?.name ?? "Your client",
        uploadUrl,
        daysUntilExpiration: daysUntil(row.expiration_date),
        expirationDate: row.expiration_date,
        carrierName: policy.carrier_name,
        policyNumber: policy.policy_number,
      };

      let sendStatus: "sent" | "failed" | "not_configured" = "not_configured";
      let providerMessageId: string | null = null;
      let sendErrorMessage: string | null = null;

      if (resendApiKey) {
        try {
          const response = await fetch(RESEND_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: FROM_ADDRESS,
              to: [vendor.contact_email],
              subject: renewalReminderSubject(emailInput),
              html: renewalReminderHtml(emailInput),
              text: renewalReminderText(emailInput),
            }),
          });
          const body = (await response.json().catch(() => ({}))) as {
            id?: string;
            message?: string;
          };
          if (response.ok) {
            sendStatus = "sent";
            providerMessageId = body.id ?? null;
          } else {
            sendStatus = "failed";
            sendErrorMessage = body.message ?? `Resend responded ${response.status}`;
          }
        } catch (error) {
          sendStatus = "failed";
          sendErrorMessage = error instanceof Error ? error.message : "Unknown error sending email";
        }
      } else {
        console.warn(
          `[send-renewal-reminders] RESEND_API_KEY is not set - not sending to ${vendor.contact_email}. ` +
            "The upload request was still created and will be retried tomorrow.",
        );
      }

      await supabase.from("email_outbox").insert({
        company_id: row.company_id,
        vendor_id: row.vendor_id,
        upload_request_id: request.id,
        template: "renewal_reminder",
        to_email: vendor.contact_email,
        status: sendStatus === "sent" ? "sent" : sendStatus === "failed" ? "failed" : "queued",
        provider_message_id: providerMessageId,
        error: sendErrorMessage,
        sent_at: sendStatus === "sent" ? new Date().toISOString() : null,
      });

      if (sendStatus === "sent") {
        await supabase
          .from("vendor_upload_requests")
          .update({ status: "email_sent" })
          .eq("id", request.id);

        // The write that makes this idempotent - see migration 10's docblock.
        // Deliberately NOT written for "failed"/"not_configured": those should
        // retry tomorrow rather than being silently marked handled.
        await supabase.from("policy_reminder_log").insert({
          company_id: row.company_id,
          vendor_id: row.vendor_id,
          policy_id: row.policy_id,
          days_threshold: row.days_threshold,
        });
        sent++;
      } else if (sendStatus === "not_configured") {
        notConfigured++;
      } else {
        failed++;
      }
    } catch (error) {
      console.error(`[send-renewal-reminders] unhandled error for policy ${row.policy_id}:`, error);
      failed++;
    }
  }

  return new Response(
    // notConfigured is deliberately separate from failed: it means "no
    // RESEND_API_KEY yet," a known deployment gap, not an error worth
    // alerting on - see the docblock above.
    JSON.stringify({ processed: dueRows.length, sent, failed, notConfigured, skipped }),
    { headers: { "Content-Type": "application/json" } },
  );
});
