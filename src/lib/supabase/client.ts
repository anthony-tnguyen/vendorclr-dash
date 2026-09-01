import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readSupabaseEnv } from "./env";

/**
 * Intentionally not parameterised with a `Database` generic.
 *
 * supabase-js infers result types from the schema type plus the select string, and
 * that inference needs a genuinely generated schema (relationship metadata and the
 * internal version marker included). A hand-written approximation makes it collapse
 * to `never` on perfectly valid queries. The repository casts to the explicit row
 * types in src/data/db-types.ts instead, which is honest about where the guarantee
 * comes from. Add the generic back once `supabase gen types` output is committed.
 */
export type VendorClearClient = SupabaseClient;

let client: VendorClearClient | null = null;

/**
 * Browser Supabase client, created once per tab.
 *
 * createBrowserClient (rather than plain createClient) stores the session in
 * cookies instead of localStorage. Nothing in Phase 0 reads those cookies
 * server-side, but it is the prerequisite for doing so: route loaders and server
 * functions can only see the session if it lives in a cookie the request carries.
 *
 * Throws when called during SSR. That is intentional and load-bearing - it turns a
 * silent "renders empty on the server" bug into a loud one. Repository methods run
 * from react-query on the client, so this is not reached during server render.
 */
export function getSupabaseClient(): VendorClearClient {
  if (typeof window === "undefined") {
    throw new Error(
      "getSupabaseClient() was called during server rendering. Phase 0 loads data from " +
        "the browser only; use a request-scoped server client for SSR data access.",
    );
  }

  if (!client) {
    const env = readSupabaseEnv();
    if (!env) {
      throw new Error(
        "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, " +
          "or leave them unset to run against the in-memory demo repository.",
      );
    }
    client = createBrowserClient(env.url, env.anonKey);
  }

  return client;
}

/** Test seam: drops the memoised client so a suite can swap env between cases. */
export function resetSupabaseClient(): void {
  client = null;
}
