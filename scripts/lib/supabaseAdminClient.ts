/**
 * Task 12 - the service-role Supabase client shared by export-company.ts
 * and delete-company.ts. Mirrors getServiceRoleClient() in
 * src/lib/supabase/serverClient.server.ts (same env var names, same
 * "no session persistence" client options) rather than importing that file
 * directly: it carries an assertServerOnly() browser guard and other
 * TanStack Start server-function wiring that make no sense for a standalone
 * CLI script (the same reasoning check-email-deliverability.ts's own
 * docblock gives for staying out of src/server/**'s Workers-request-path
 * restrictions - this is a script a person runs from their own machine or
 * CI, not application code).
 *
 * Both scripts that use this talk to a LIVE Supabase project with the
 * service-role key, which bypasses RLS entirely. Nothing in this file
 * decides what is safe to do with that access - export-company.ts only
 * ever reads, and delete-company.ts's own confirmation gates (see its
 * docblock) are what stand between this client and an irreversible delete.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function getAdminClient(): SupabaseClient {
  const url = process.env["VENDORCLEAR_SUPABASE_URL"]?.trim();
  const key = process.env["VENDORCLEAR_SERVICE_ROLE_KEY"]?.trim();

  if (!url) {
    throw new Error(
      "VENDORCLEAR_SUPABASE_URL must be set to run this script against a real project.",
    );
  }
  if (!key) {
    throw new Error(
      "VENDORCLEAR_SERVICE_ROLE_KEY must be set to run this script against a real project.",
    );
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
