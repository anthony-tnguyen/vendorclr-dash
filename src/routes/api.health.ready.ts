import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

/**
 * Readiness: liveness (api.health.live.ts) plus "can this instance actually
 * do its job right now" - Supabase reachability via one cheap query (a
 * HEAD/count request against a small table, never a full scan) and which
 * optional integrations are configured, reported as booleans BY NAME ONLY.
 * No env var value, connection string, key or secret is ever placed in this
 * response body - only whether each one is set. See buildReadyHealthPayload()'s
 * ConfigurationPresence type: every field is a boolean.
 *
 * See api.health.live.ts's docblock and src/start.ts's healthCheckMiddleware
 * for why the real answer to a direct GET /api/health/ready comes from a
 * request middleware, not this route's own beforeLoad (kept only as a
 * fallback for client-side navigation) - this version of
 * @tanstack/react-start has no dedicated server-route export, and a route's
 * own beforeLoad/loader throwing a Response does not short-circuit to a raw
 * HTTP response the way a request middleware's does.
 */

export interface ConfigurationPresence {
  /** VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY - the browser-facing client config read by src/lib/supabase/env.ts. */
  supabaseUrl: boolean;
  supabaseAnonKey: boolean;
  /** VENDORCLEAR_SUPABASE_URL / VENDORCLEAR_SERVICE_ROLE_KEY - the server-only service-role client read by serverClient.server.ts. */
  supabaseServiceRoleUrl: boolean;
  supabaseServiceRoleKey: boolean;
  /** See src/workflows/emailSender.ts. */
  resendApiKey: boolean;
  /** See src/workflows/documentExtraction.ts. */
  anthropicApiKey: boolean;
  /** See src/workflows/malwareScanner.ts. */
  virustotalApiKey: boolean;
  /** See src/lib/observability/sentry.server.ts / sentryClient.ts. */
  sentryDsn: boolean;
}

export type DependencyStatus = "ok" | "unreachable" | "not_configured";

export interface ReadyHealthPayload {
  status: "ok" | "degraded";
  time: string;
  releaseSha: string;
  environment: string;
  dependencies: {
    supabase: DependencyStatus;
  };
  configuration: ConfigurationPresence;
}

function readConfigurationPresence(): ConfigurationPresence {
  const present = (value: string | undefined): boolean => Boolean(value && value.trim());
  return {
    supabaseUrl: present(import.meta.env["VITE_SUPABASE_URL"] as string | undefined),
    supabaseAnonKey: present(import.meta.env["VITE_SUPABASE_ANON_KEY"] as string | undefined),
    supabaseServiceRoleUrl: present(process.env["VENDORCLEAR_SUPABASE_URL"]),
    supabaseServiceRoleKey: present(process.env["VENDORCLEAR_SERVICE_ROLE_KEY"]),
    resendApiKey: present(process.env["RESEND_API_KEY"]),
    anthropicApiKey: present(process.env["ANTHROPIC_API_KEY"]),
    virustotalApiKey: present(process.env["VIRUSTOTAL_API_KEY"]),
    sentryDsn: present(import.meta.env["VITE_SENTRY_DSN"] as string | undefined),
  };
}

/**
 * Loaded lazily (not a static import): serverClient.server.ts throws if
 * imported into browser code (see its own assertServerOnly() guard), and a
 * static import here would put it in the client bundle's import graph -
 * same reasoning vendorUploadRequests.ts already documents for its own
 * lazy getServiceRoleClient()/getRequestScopedClient() wrappers.
 */
async function checkSupabase(configured: boolean): Promise<DependencyStatus> {
  if (!configured) return "not_configured";
  try {
    const mod = await import("@/lib/supabase/serverClient.server");
    const supabase = mod.getServiceRoleClient();
    // count-only HEAD request - no rows returned, no full scan, just proves
    // the connection and credentials actually work.
    const { error } = await supabase.from("companies").select("id", { head: true, count: "exact" });
    return error ? "unreachable" : "ok";
  } catch {
    return "unreachable";
  }
}

export async function buildReadyHealthPayload(): Promise<{
  payload: ReadyHealthPayload;
  httpStatus: number;
}> {
  const configuration = readConfigurationPresence();
  const supabaseStatus = await checkSupabase(
    configuration.supabaseServiceRoleUrl && configuration.supabaseServiceRoleKey,
  );

  const overallOk = supabaseStatus !== "unreachable";

  const payload: ReadyHealthPayload = {
    status: overallOk ? "ok" : "degraded",
    time: new Date().toISOString(),
    releaseSha: (import.meta.env["VITE_RELEASE_SHA"] as string | undefined)?.trim() || "unknown",
    environment: import.meta.env.MODE || "unknown",
    dependencies: { supabase: supabaseStatus },
    configuration,
  };

  // 503 when the one dependency we can actually check is unreachable, so an
  // uptime monitor/load balancer can act on the status code alone without
  // parsing the body. "not_configured" (demo mode, no Supabase project
  // wired up) is not a failure - it is this app's normal, supported state.
  return { payload, httpStatus: overallOk ? 200 : 503 };
}

/**
 * The route below must call this, not buildReadyHealthPayload() directly:
 * a route file's beforeLoad/loader are both part of the client bundle's own
 * module graph (client-side navigation runs them too), so anything called
 * directly from either is subject to client-bundle import protection.
 * createServerFn()'s .handler() callback is the one place this project's
 * build specifically strips to a server-only chunk (replacing client-side
 * calls with an RPC bridge instead) - the same mechanism
 * vendorUploadRequests.ts's createServerFn-wrapped functions already rely
 * on to keep getServiceRoleClient() out of the browser bundle. Confirmed by
 * `bun run build`: calling buildReadyHealthPayload() (which transitively
 * imports serverClient.server.ts) directly from the route fails the
 * build's import-protection check; routing the same call through this
 * server function fixes it.
 */
const checkReadyHealth = createServerFn({ method: "GET" }).handler(() => buildReadyHealthPayload());

export const Route = createFileRoute("/api/health/ready")({
  // Fallback only - see this file's top docblock. The real answer to a
  // direct GET /api/health/ready comes from healthCheckMiddleware in
  // src/start.ts.
  beforeLoad: async () => {
    const { payload, httpStatus } = await checkReadyHealth();
    throw Response.json(payload, { status: httpStatus });
  },
});
