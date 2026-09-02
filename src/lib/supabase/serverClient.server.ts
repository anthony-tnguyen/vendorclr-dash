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
 * getServiceRoleClient() bypasses RLS entirely. It exists only for the two
 * vendor-portal endpoints with no session to run as - resolveUploadToken() and
 * uploadDocumentForToken() in vendorUploadRequests.ts. Both
 * independently re-validate the hashed token, its expiry and its status before
 * touching a row; the service-role key does not replace that check; it exists
 * because there is no auth.uid() for an anonymous vendor to check against.
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
  const url = readSupabaseEnv()?.url;
  // Deliberately NOT VITE_-prefixed: a VITE_ var ships to the browser bundle,
  // and this key must never reach it.
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim();

  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY (and VITE_SUPABASE_URL) must both be set to use the vendor " +
        "upload portal server functions.",
    );
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
