// @ts-nocheck - runs in Supabase's Deno Edge Runtime, not the app's Node/
// TypeScript project (see create-checkout/index.ts's header for why).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@18.5.0";

import { logOperational, newRequestId } from "./operationalLog.ts";

/**
 * Public HTTP endpoint Stripe calls on billing lifecycle events. Deployed with
 * verify_jwt=false: Stripe has no Supabase session, so authenticity is proven
 * by Stripe's own signature (STRIPE_WEBHOOK_SECRET), verified below. An unset
 * secret or a failed signature REFUSES the request (401/400) rather than
 * accepting an unverified call — a forged checkout.session.completed could
 * otherwise mint a paid workspace for free.
 *
 * Retry-safe idempotency (Stripe may duplicate, retry or reorder events):
 *   - Each event id is recorded in stripe_events on receipt.
 *   - A duplicate is ignored ONLY once processed_at is set — i.e. once
 *     provisioning actually finished. If a prior attempt failed (processed_at
 *     still null), the retry is reprocessed rather than swallowed, so a
 *     half-provisioned workspace cannot be stranded forever.
 *   - Every handler is itself idempotent (guards on stripe_subscription_id /
 *     existing membership, plus unique indexes), so concurrent duplicate
 *     deliveries cannot create two workspaces.
 *
 * Access is granted after payment: a workspace is only marked activated while
 * the subscription is active/trialing; incomplete/past-due checkouts create the
 * row but keep it closed until invoice.paid confirms payment.
 *
 * Runs on the service role because Stripe is not a signed-in company member and
 * this must write whichever company's row the event names.
 */

const STRIPE_API_VERSION = "2026-06-24.dahlia";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Mirror of activationFromSubscriptionStatus() in
// src/domain/billing/webhookRules.ts — keep in sync (Deno cannot import src).
// active/trialing grant access; canceled/unpaid/incomplete_expired revoke it;
// transitional states (past_due, incomplete, paused) leave activation unchanged.
function activationFromStatus(status: string): "activated" | "revoked" | null {
  if (status === "active" || status === "trialing") return "activated";
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
    return "revoked";
  }
  return null;
}

function subscriptionPeriodEnd(subscription: Stripe.Subscription): string | null {
  // current_period_end moved onto the subscription item in recent API versions;
  // fall back to the (older) top-level field so this is robust either way.
  const itemEnd = subscription.items?.data?.[0]?.current_period_end;
  const raw =
    itemEnd ?? (subscription as unknown as { current_period_end?: number }).current_period_end;
  return typeof raw === "number" ? new Date(raw * 1000).toISOString() : null;
}

function readCustomField(session: Stripe.Checkout.Session, key: string): string | null {
  const field = (session.custom_fields ?? []).find((f) => f.key === key);
  const value = field?.text?.value?.trim();
  return value ? value : null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string {
  const sub = (invoice as unknown as { subscription?: unknown }).subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object" && typeof (sub as { id?: unknown }).id === "string") {
    return (sub as { id: string }).id;
  }
  return "";
}

async function handleCheckoutCompleted(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  session: Stripe.Checkout.Session,
  requestId: string,
): Promise<void> {
  if (session.mode !== "subscription") return;

  const userId = session.client_reference_id || (session.metadata?.user_id ?? "");
  const plan = session.metadata?.plan ?? "";
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
  const customerId = typeof session.customer === "string" ? session.customer : "";
  if (!userId || !plan || !subscriptionId) {
    throw new Error("checkout.session.completed missing user_id, plan or subscription");
  }

  // Idempotency beyond the stripe_events gate: if this subscription already has
  // a company, or this account already has a workspace, do not create another.
  const { data: bySub, error: bySubError } = await supabase
    .from("companies")
    .select("id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (bySubError) throw bySubError;
  if (bySub) return;

  const { data: membership, error: membershipError } = await supabase
    .from("company_members")
    .select("company_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (membership) {
    logOperational({
      level: "warn",
      event: "checkout_account_already_has_workspace",
      requestId,
      actorId: userId,
      route: "stripe-webhook",
      outcome: "failure",
    });
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const periodEnd = subscriptionPeriodEnd(subscription);
  const companyName =
    readCustomField(session, "company_name") || session.customer_details?.name || "New workspace";
  const billingEmail = session.customer_details?.email ?? null;
  // Grant access only if the subscription is already paid & usable; otherwise
  // the workspace is created closed and invoice.paid will open it.
  const activation =
    activationFromStatus(subscription.status) === "activated" ? "activated" : "demo";

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .insert({
      name: companyName.slice(0, 200),
      plan,
      activation_status: activation,
      activated_at: activation === "activated" ? new Date().toISOString() : null,
      service_status: "onboarding",
      stripe_customer_id: customerId || null,
      stripe_subscription_id: subscriptionId,
      subscription_status: subscription.status,
      current_period_end: periodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end ?? false,
      billing_email: billingEmail,
      subscription_renews_on: periodEnd ? periodEnd.slice(0, 10) : null,
    })
    .select("id")
    .single();
  if (companyError) throw companyError;

  const { error: memberError } = await supabase.from("company_members").insert({
    company_id: company.id,
    user_id: userId,
    role: "owner",
    last_active_at: new Date().toISOString(),
  });
  if (memberError) throw memberError;

  const { error: onboardingError } = await supabase.from("company_onboarding").insert({
    company_id: company.id,
    current_step: 1,
    company_info: { name: companyName },
  });
  if (onboardingError) throw onboardingError;

  // Audit rows are best-effort — a failure here must not strand provisioning or
  // cause an endless retry of an otherwise-complete workspace.
  const { error: auditError } = await supabase.from("audit_log").insert([
    {
      company_id: company.id,
      actor_id: userId,
      action: "checkout_completed",
      target_type: "company",
      target_id: company.id,
      detail: { plan, source: "self_checkout" },
    },
    {
      company_id: company.id,
      actor_id: userId,
      action: "company_activated",
      target_type: "company",
      target_id: company.id,
      detail: { plan, source: "self_checkout", activation },
    },
  ]);
  if (auditError) {
    logOperational({
      level: "warn",
      event: "checkout_audit_insert_failed",
      requestId,
      companyId: company.id,
      route: "stripe-webhook",
      outcome: "failure",
    });
  }

  logOperational({
    level: "info",
    event: "company_created_from_checkout",
    requestId,
    companyId: company.id,
    actorId: userId,
    route: "stripe-webhook",
    outcome: "success",
  });
}

async function handleSubscriptionChange(
  supabase: ReturnType<typeof createClient>,
  subscription: Stripe.Subscription,
  requestId: string,
): Promise<void> {
  const status = subscription.status;
  const periodEnd = subscriptionPeriodEnd(subscription);
  const activation = activationFromStatus(status);

  const patch: Record<string, unknown> = {
    subscription_status: status,
    current_period_end: periodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end ?? false,
  };
  if (periodEnd) patch.subscription_renews_on = periodEnd.slice(0, 10);
  if (activation) patch.activation_status = activation;

  const { data: rows, error } = await supabase
    .from("companies")
    .update(patch)
    .eq("stripe_subscription_id", subscription.id)
    .select("id");
  if (error) throw error;

  for (const row of rows ?? []) {
    const { error: auditError } = await supabase.from("audit_log").insert({
      company_id: row.id,
      actor_id: null,
      action: "subscription_updated",
      target_type: "company",
      target_id: row.id,
      detail: {
        subscription_status: status,
        cancel_at_period_end: subscription.cancel_at_period_end ?? false,
      },
    });
    if (auditError) {
      logOperational({
        level: "warn",
        event: "subscription_audit_insert_failed",
        requestId,
        companyId: row.id,
        route: "stripe-webhook",
        outcome: "failure",
      });
    }
    logOperational({
      level: activation === "revoked" ? "warn" : "info",
      event: "subscription_synced",
      requestId,
      companyId: row.id,
      route: "stripe-webhook",
      outcome: "success",
    });
  }
}

/**
 * invoice.paid — a subscription payment succeeded (initial or renewal). This is
 * the "grant access after payment" signal: mark the workspace active and open,
 * unless it was already revoked (a canceled subscription's final invoice).
 */
async function handleInvoicePaid(
  supabase: ReturnType<typeof createClient>,
  invoice: Stripe.Invoice,
  requestId: string,
): Promise<void> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return; // not a subscription invoice

  const { data: rows, error } = await supabase
    .from("companies")
    .update({ subscription_status: "active", activation_status: "activated" })
    .eq("stripe_subscription_id", subscriptionId)
    .neq("activation_status", "revoked")
    .select("id");
  if (error) throw error;

  for (const row of rows ?? []) {
    logOperational({
      level: "info",
      event: "invoice_paid_activated",
      requestId,
      companyId: row.id,
      route: "stripe-webhook",
      outcome: "success",
    });
  }
}

/**
 * invoice.payment_failed — record the dunning state. Access is not revoked here;
 * Stripe keeps retrying and customer.subscription.updated/deleted decides the
 * final outcome (past_due -> unpaid/canceled), which handleSubscriptionChange
 * turns into a revoke.
 */
async function handleInvoicePaymentFailed(
  supabase: ReturnType<typeof createClient>,
  invoice: Stripe.Invoice,
  requestId: string,
): Promise<void> {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;

  const { data: rows, error } = await supabase
    .from("companies")
    .update({ subscription_status: "past_due" })
    .eq("stripe_subscription_id", subscriptionId)
    .select("id");
  if (error) throw error;

  for (const row of rows ?? []) {
    logOperational({
      level: "warn",
      event: "invoice_payment_failed",
      requestId,
      companyId: row.id,
      route: "stripe-webhook",
      outcome: "failure",
    });
  }
}

Deno.serve(async (req: Request) => {
  const requestId = newRequestId();
  const route = "stripe-webhook";

  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")?.trim();
  if (!stripeSecret || !webhookSecret) {
    logOperational({
      level: "warn",
      event: "webhook_not_configured",
      requestId,
      route,
      outcome: "failure",
    });
    return json({ error: "Webhook not configured" }, 401);
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return json({ error: "Missing signature" }, 401);
  }

  const rawBody = await req.text();
  const stripe = new Stripe(stripeSecret, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    logOperational({
      level: "warn",
      event: "webhook_signature_invalid",
      requestId,
      route,
      outcome: "failure",
    });
    return json({ error: "Invalid signature" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Retry-safe idempotency: a duplicate is only skipped once provisioning has
  // actually finished (processed_at set). A previously-failed attempt (row
  // exists, processed_at null) is reprocessed rather than swallowed.
  const { data: existing, error: existingError } = await supabase
    .from("stripe_events")
    .select("processed_at")
    .eq("id", event.id)
    .maybeSingle();
  if (existingError) {
    logOperational({
      level: "error",
      event: "event_lookup_failed",
      requestId,
      route,
      outcome: "failure",
    });
    return json({ error: "Could not read event" }, 500);
  }
  if (existing?.processed_at) {
    return json({ ok: true, duplicate: true });
  }

  // Record receipt (durable copy). ignoreDuplicates so a re-delivery of an
  // unprocessed event does not error; existence is NOT the completion signal.
  const { error: recordError } = await supabase
    .from("stripe_events")
    .upsert(
      { id: event.id, type: event.type, payload: event as unknown as Record<string, unknown> },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (recordError) {
    logOperational({
      level: "error",
      event: "event_record_failed",
      requestId,
      route,
      outcome: "failure",
    });
    return json({ error: "Could not record event" }, 500);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await handleCheckoutCompleted(
          stripe,
          supabase,
          event.data.object as Stripe.Checkout.Session,
          requestId,
        );
        break;
      case "checkout.session.async_payment_failed":
        logOperational({
          level: "warn",
          event: "checkout_async_payment_failed",
          requestId,
          route,
          outcome: "failure",
        });
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionChange(
          supabase,
          event.data.object as Stripe.Subscription,
          requestId,
        );
        break;
      case "invoice.paid":
        await handleInvoicePaid(supabase, event.data.object as Stripe.Invoice, requestId);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(supabase, event.data.object as Stripe.Invoice, requestId);
        break;
      default:
        // Recorded, nothing to do.
        break;
    }
    await supabase
      .from("stripe_events")
      .update({ processed_at: new Date().toISOString(), error: null })
      .eq("id", event.id);
  } catch (error) {
    // Record the failure and return 500 so Stripe retries with backoff. Leaving
    // processed_at null is what lets the retry actually reprocess this event.
    await supabase
      .from("stripe_events")
      .update({ error: error instanceof Error ? error.message : String(error) })
      .eq("id", event.id);
    logOperational({
      level: "error",
      event: "webhook_handler_failed",
      requestId,
      route,
      outcome: "failure",
    });
    return json({ error: "Handler failed" }, 500);
  }

  return json({ ok: true });
});
