// @ts-nocheck - runs in Supabase's Deno Edge Runtime, not the app's Node/
// TypeScript project (see create-checkout/index.ts's header for why).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@18.5.0";

import { logOperational, newRequestId } from "./operationalLog.ts";

/**
 * Returns a Stripe billing-portal URL for the caller's company, so an owner can
 * update the card, see invoices or cancel. Deployed with verify_jwt=true; the
 * caller is read from their JWT and mapped to their company's stripe_customer_id
 * with the service role. Refuses (400) a company that has no Stripe customer,
 * e.g. an activation-code / enterprise workspace with no self-checkout subscription.
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

const STRIPE_API_VERSION = "2026-06-24.dahlia";

Deno.serve(async (req: Request) => {
  const requestId = newRequestId();
  const route = "billing-portal";

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY")?.trim();
  const appUrl = Deno.env.get("APP_URL")?.trim().replace(/\/+$/, "");
  if (!stripeSecret || !appUrl) {
    logOperational({ level: "warn", event: "portal_not_configured", requestId, route, outcome: "failure" });
    return json({ error: "Billing portal is not configured." }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: membership } = await admin
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) {
    return json({ error: "This account has no workspace." }, 400);
  }

  const { data: company } = await admin
    .from("companies")
    .select("stripe_customer_id")
    .eq("id", membership.company_id)
    .maybeSingle();
  const customerId = company?.stripe_customer_id;
  if (!customerId) {
    return json({ error: "This workspace has no self-checkout subscription to manage." }, 400);
  }

  const stripe = new Stripe(stripeSecret, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${appUrl}/dashboard/settings`,
  });

  logOperational({ level: "info", event: "billing_portal_opened", requestId, companyId: membership.company_id, actorId: user.id, route, outcome: "success" });
  return json({ url: session.url });
});
