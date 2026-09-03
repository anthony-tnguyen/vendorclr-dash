// @ts-nocheck - this file runs in Supabase's Deno Edge Runtime, not the app's
// Node/TypeScript project; its imports (jsr:) and Deno globals are not
// resolvable by the repo's own tsc/eslint config, which is why it is excluded
// there (see eslint.config.js) and verified instead by deploying it and
// invoking it against the live project (supabase/README.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { verifySvixSignature } from "./svixSignature.ts";

/**
 * Public HTTP endpoint Resend calls directly on an email's delivery
 * lifecycle events - https://resend.com/docs/dashboard/webhooks/introduction.
 * Deployed with verify_jwt=false: Resend has no Supabase session to send a
 * platform JWT with, so authenticity is verified through Resend's own
 * Svix-signed webhook scheme instead (RESEND_WEBHOOK_SECRET, checked via
 * verifySvixSignature() - see that file's docblock for where the algorithm
 * itself was confirmed).
 *
 * Unlike every other "not configured" case in this project, which degrades
 * gracefully and lets the surrounding action proceed, an unset secret or a
 * failed signature check here REFUSES the request outright (401), not
 * "accept and hope." Accepting an unverified call would let anyone forge a
 * bounce/complaint event against any company's email_outbox row - there is
 * nothing gentle to degrade to.
 *
 * Writes two things per event that matches a known email_outbox row (by
 * provider_message_id, which the app already records at send time):
 *   - Always: an email_delivery_events row - the append-only history
 *     migration 19 exists for (an email's post-send lifecycle is
 *     genuinely multi-event, not representable by a single mutable
 *     status column).
 *   - Only for delivered/bounced/complained: email_outbox.status is
 *     updated to match, for at-a-glance dashboards without a join. A bare
 *     "sent" or "delivery_delayed" event is logged but does not overwrite
 *     status - the app already sets 'sent' at send time, and a delay is
 *     transient/informational, not a new outcome.
 *
 * Runs on the service role: Resend is not a signed-in company member, and
 * this must be able to write to whichever company's email_outbox row the
 * event names, not one tenant's.
 */

interface ResendWebhookEvent {
  type: string;
  created_at: string;
  data: { email_id?: string; [key: string]: unknown };
}

/** Resend event type -> this schema's event_type vocabulary. Anything not listed here (e.g. email.opened/email.clicked) is acknowledged but not recorded - see the docblock above for why only these five matter to compliance tracking today. */
const EVENT_TYPE_MAP: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

/** Which mapped event types are actual delivery *outcomes* worth overwriting email_outbox.status for. */
const STATUS_OVERRIDING_EVENTS = new Set(["delivered", "bounced", "complained"]);

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET")?.trim();
  if (!secret) {
    console.warn("[resend-webhook] RESEND_WEBHOOK_SECRET is not set - refusing this call.");
    return new Response(JSON.stringify({ error: "Webhook not configured" }), { status: 401 });
  }

  const rawBody = await req.text();
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response(JSON.stringify({ error: "Missing signature headers" }), { status: 401 });
  }

  const verified = await verifySvixSignature({ secret, svixId, svixTimestamp, rawBody, svixSignature });
  if (!verified) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const eventType = EVENT_TYPE_MAP[event.type];
  const emailId = event.data?.email_id;
  if (!eventType || !emailId) {
    // Not a tracked event type, or no email_id to match against - 200 so
    // Resend does not retry a call there is nothing actionable to do with.
    return new Response(JSON.stringify({ ok: true, ignored: event.type }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: outboxRow } = await supabase
    .from("email_outbox")
    .select("id, company_id")
    .eq("provider_message_id", emailId)
    .maybeSingle();

  if (!outboxRow) {
    // No row to attach this to - could be an email this app never sent, or
    // one sent before provider_message_id was recorded. Still 200: the
    // event was received and understood, there is simply nothing to update.
    return new Response(JSON.stringify({ ok: true, unmatched: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  await supabase.from("email_delivery_events").insert({
    company_id: outboxRow.company_id,
    email_outbox_id: outboxRow.id,
    event_type: eventType,
    detail: event.data ?? {},
    occurred_at: event.created_at,
  });

  if (STATUS_OVERRIDING_EVENTS.has(eventType)) {
    await supabase.from("email_outbox").update({ status: eventType }).eq("id", outboxRow.id);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
