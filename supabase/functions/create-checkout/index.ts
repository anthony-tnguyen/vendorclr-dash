// @ts-nocheck - this file runs in Supabase's Deno Edge Runtime, not the app's
// Node/TypeScript project; its imports (jsr:/npm:) and Deno globals are not
// resolvable by the repo's own tsc/eslint config, which is why it is excluded
// there (see eslint.config.js) and verified instead by deploying it and
// invoking it against the live project (supabase/README.md).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@18.5.0";

import { logOperational, newRequestId } from "./operationalLog.ts";

/**
 * Starts a Stripe Checkout Session for a self-serve subscription and returns
 * its hosted URL. Called by the app through supabase.functions.invoke, which
 * attaches the caller's session JWT; deployed with verify_jwt=true so the
 * platform rejects anonymous calls before this runs, and the caller's identity
 * is read from that JWT here.
 *
 * Account-first checkout: the buyer already has a Supabase account when this
 * runs, so client_reference_id / subscription metadata carry their user id and
 * the webhook (stripe-webhook) can attach the new company to exactly that
 * account. One workspace per account: a caller who already belongs to a company
 * is refused (409) rather than billed for a second one.
 *
 * The Stripe secret lives only here (STRIPE_SECRET_KEY, a restricted key is
 * recommended). Like the other secret-gated endpoints in this project, an unset
 * secret refuses the request (503) rather than pretending to work.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Must match SELF_CHECKOUT_PLAN_IDS in src/domain/billing/plans.ts and the
// plan_limits.self_checkout column. Enterprise is sales-assisted only.
const SELF_CHECKOUT_PLANS = new Set(["core", "operations", "scale"]);
const STRIPE_API_VERSION = "2026-06-24.dahlia";

Deno.serve(async (req: Request) => {
  const requestId = newRequestId();
  const route = "create-checkout";

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  const appUrl = Deno.env.get("APP_URL")?.trim().replace(/\/+$/, "");
  if (!stripeSecret) {
    logOperational({ level: "warn", event: "checkout_not_configured", requestId, route, outcome: "failure" });
    return json({ error: "Checkout is not configured." }, 503);
  }
  if (!appUrl) {
    logOperational({ level: "warn", event: "app_url_not_configured", requestId, route, outcome: "failure" });
    return json({ error: "Checkout is not configured." }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Identify the caller from their JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  const authed = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user },
    error: userError,
  } = await authed.auth.getUser();
  if (userError || !user) {
    return json({ error: "Not authenticated." }, 401);
  }

  let body: { plan?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const plan = typeof body.plan === "string" ? body.plan : "";
  if (!SELF_CHECKOUT_PLANS.has(plan)) {
    return json({ error: "That plan is not available for self-checkout." }, 400);
  }

  // One workspace per account. Service role because company_members is not
  // readable across tenants and this caller may not be a member of any yet.
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: existingMembership, error: membershipError } = await admin
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError) {
    logOperational({ level: "error", event: "membership_lookup_failed", requestId, route, outcome: "failure" });
    return json({ error: "Could not start checkout." }, 500);
  }
  if (existingMembership) {
    return json({ error: "This account already has a VendorClr workspace." }, 409);
  }

  const stripe = new Stripe(stripeSecret, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Resolve the price by its stable lookup key rather than a hard-coded id, so
  // sandbox and live can carry different price ids under the same key.
  const lookupKey = `vendorclr_${plan}_monthly`;
  const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) {
    logOperational({ level: "error", event: "price_not_found", requestId, route, outcome: "failure" });
    return json({ error: "This plan is not available right now." }, 500);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: user.id,
    customer_email: user.email,
    // Discounts (access codes, founding-customer offers, etc.) at checkout
    // without ever showing crossed-out public pricing.
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    // Capture the company name at pay time so the workspace has a real name the
    // moment it is created; onboarding Step 1 can refine it.
    custom_fields: [
      {
        key: "company_name",
        label: { type: "custom", custom: "Company name" },
        type: "text",
      },
    ],
    subscription_data: { metadata: { user_id: user.id, plan } },
    metadata: { user_id: user.id, plan },
    success_url: `${appUrl}/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/checkout?canceled=1`,
  });

  logOperational({ level: "info", event: "checkout_session_created", requestId, actorId: user.id, route, outcome: "success" });
  return json({ url: session.url });
});
