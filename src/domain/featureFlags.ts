/**
 * Per-company feature flags gating flows that don't exist in the app yet
 * (construction schema, requirement profiles, team invites, submission
 * packages, deficiency cases, exceptions, reports v2). All keys default to
 * false in the database (supabase/migrations/20260916000100_company_feature_flags.sql);
 * this module just gives that table a typed key union and a server-only
 * reader. Nothing in the app calls isCompanyFeatureEnabled() yet - it exists
 * so the features it will gate can be built behind it later, rather than
 * behind an ad hoc check invented at the point of use.
 *
 * FEATURE_FLAG_KEYS/FeatureFlagKey are plain values/types, safe to import
 * from client code (e.g. to render an admin toggle list). Only
 * isCompanyFeatureEnabled() touches the database, and it does so lazily -
 * see the comment on getRequestScopedClient() below - so this file can stay
 * named featureFlags.ts rather than needing a .server.ts suffix.
 */

export const FEATURE_FLAG_KEYS = [
  "construction_core",
  "requirement_profiles",
  "team_invites",
  "submission_packages",
  "deficiency_cases",
  "exceptions",
  "reports_v2",
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return (FEATURE_FLAG_KEYS as readonly string[]).includes(value);
}

/**
 * Loaded lazily inside isCompanyFeatureEnabled(): a static import of the
 * *.server module would put it in the client import graph the moment any
 * client code imports FEATURE_FLAG_KEYS from this file, which the build's
 * import protection rejects. Same pattern as vendorUploadRequests.ts.
 */
async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

/**
 * Server-only reader: is `key` enabled for `companyId`?
 *
 * Runs as the signed-in caller via the request-scoped client, so RLS decides
 * visibility exactly as any other read - a member can only ever resolve
 * flags for a company they belong to, and a platform admin can resolve any
 * company's (see company_feature_flags_select in the migration). A missing
 * row reads as disabled: flags default off, and a company need not have
 * every key populated for that default to hold.
 *
 * Throws rather than defaulting to enabled on a query error - a flag gating
 * an unfinished flow must fail closed, not open.
 */
export async function isCompanyFeatureEnabled(
  companyId: string,
  key: FeatureFlagKey,
): Promise<boolean> {
  const supabase = await getRequestScopedClient();

  const result = (await supabase
    .from("company_feature_flags")
    .select("enabled")
    .eq("company_id", companyId)
    .eq("key", key)
    .maybeSingle()) as unknown as {
    data: { enabled: boolean } | null;
    error: { message: string } | null;
  };

  if (result.error) {
    throw new Error(
      `Could not read feature flag "${key}" for company ${companyId}: ${result.error.message}`,
    );
  }

  return result.data?.enabled ?? false;
}
