import { createFileRoute } from "@tanstack/react-router";

/**
 * Liveness only: "is this process able to respond at all." No Supabase call,
 * no dependency check of any kind - deliberately, so this endpoint still
 * answers even when Supabase (or anything else this app depends on) is
 * fully down. That distinction is the whole point of splitting this from
 * /api/health/ready (api.health.ready.ts), which does check dependencies.
 *
 * @tanstack/react-start@1.168.32 (the exact version pinned in this repo -
 * confirmed in node_modules, not assumed) has no `createServerFileRoute`/
 * dedicated server-route export - that is a later addition to the
 * TanStack Start ecosystem this pinned version predates. A route's own
 * beforeLoad/loader throwing a Response was the first mechanism tried here
 * and does NOT work in this version for a full-document request: it gets
 * treated as a render-time error and caught by __root.tsx's own error
 * boundary instead of short-circuiting to a raw HTTP response - confirmed
 * empirically against both `bun run dev` and a `wrangler dev` run of the
 * actual production build, not assumed from reading source alone. The
 * beforeLoad below is kept only as a harmless fallback for the (unrealistic)
 * case of client-side navigation to this path; the real response for an
 * actual GET /api/health/live is delivered by healthCheckMiddleware in
 * src/start.ts, a REQUEST middleware - that layer's thrown/returned
 * Response genuinely is caught and returned directly by start-server-core's
 * request pipeline (`if (err instanceof Response) return err`, confirmed by
 * reading createStartHandler.js AND by the curl output in this task's
 * report). See src/start.ts's healthCheckMiddleware docblock for the full
 * explanation and the empirical evidence.
 */

export interface LiveHealthPayload {
  status: "ok";
  time: string;
  releaseSha: string;
  environment: string;
}

/**
 * VITE_RELEASE_SHA is a build-time var a future CI deploy step would set
 * from $GITHUB_SHA (no CD pipeline exists yet - Task 13); it correctly
 * falls back to "unknown" for local dev/build today. `environment` is
 * Vite's own built-in `MODE` ("development"/"production"), needing no new
 * env var.
 */
export function buildLiveHealthPayload(): LiveHealthPayload {
  return {
    status: "ok",
    time: new Date().toISOString(),
    releaseSha: (import.meta.env["VITE_RELEASE_SHA"] as string | undefined)?.trim() || "unknown",
    environment: import.meta.env.MODE || "unknown",
  };
}

export const Route = createFileRoute("/api/health/live")({
  // Fallback only - see this file's top docblock. The real answer to a
  // direct GET /api/health/live comes from healthCheckMiddleware in
  // src/start.ts.
  beforeLoad: () => {
    throw Response.json(buildLiveHealthPayload());
  },
});
