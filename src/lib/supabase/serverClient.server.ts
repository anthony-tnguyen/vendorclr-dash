import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getCookies, setCookie } from "@tanstack/react-start/server";

import { readSupabaseEnv } from "./env";

/**
 * Two server-only Supabase clients, for two different kinds of caller.
 *
 * getRequestScopedClient() runs AS the signed-in caller, via their session
 * cookie. Everything through it goes through RLS exactly as if the browser
 * made the call - so "can this admin create an upload request for this
 * vendor" is decided once, by the can_write_company() policy, and is never
 * re-implemented here. Use this for every authenticated action.
 *
 * getServiceRoleClient() bypasses RLS entirely. Two different justifications
 * use it, never a third without one:
 *
 *   - The vendor-portal endpoints with no session to run as -
 *     resolveUploadToken() and uploadDocumentForToken() in
 *     vendorUploadRequests.ts. Both independently re-validate the hashed
 *     token, its expiry and its status before touching a row; the
 *     service-role key does not replace that check, it exists because there
 *     is no auth.uid() for an anonymous vendor to check against.
 *   - Staff-only actions on customer data that RLS's company-membership
 *     model was never meant to grant - reprocessDocument() and the review
 *     screen's approve/reject actions in documentReview.ts.
 *     assertPlatformAdmin() (vendorUploadRequests.ts) re-validates the
 *     caller is platform staff via RLS/auth.uid() first; the service-role
 *     key does not replace that check either, it exists because
 *     can_write_company() is deliberately company-membership-only and staff
 *     reviewing a customer's documents have none.
 *
 * Both throw if imported into browser code. TanStack Start's compiler strips
 * server-function handler bodies from the client bundle, but this guard turns
 * a bundling regression into an immediate error instead of a leaked secret.
 */

function assertServerOnly(fnName: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `${fnName}() was called from the browser. It uses server-only secrets and must only ` +
        "run inside a server function handler.",
    );
  }
}

export function getRequestScopedClient(): SupabaseClient {
  assertServerOnly("getRequestScopedClient");
  const env = readSupabaseEnv();
  if (!env) throw new Error("Supabase is not configured.");

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => Object.entries(getCookies()).map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          setCookie(cookie.name, cookie.value, cookie.options);
        }
      },
    },
  });
}

export function getServiceRoleClient(): SupabaseClient {
  assertServerOnly("getServiceRoleClient");
  // These use custom names because the secret store reserves the SUPABASE_
  // prefix for managed connections. Neither may be VITE_-prefixed: VITE_
  // values are build-time browser configuration, while this privileged client
  // must be configured directly by the server runtime.
  const url = process.env["VENDORCLEAR_SUPABASE_URL"]?.trim();
  const key = process.env["VENDORCLEAR_SERVICE_ROLE_KEY"]?.trim();

  if (!url) {
    throw new Error(
      "VENDORCLEAR_SUPABASE_URL must be set to use the vendor upload portal server functions.",
    );
  }
  if (!key) {
    throw new Error(
      "VENDORCLEAR_SERVICE_ROLE_KEY must be set to use the vendor upload portal server functions.",
    );
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
