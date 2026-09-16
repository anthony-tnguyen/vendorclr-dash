/**
 * Server-side (SSR / server functions / TanStack Start API routes) Sentry
 * error capture. See sentryEnvelope.ts's docblock for why this hand-rolls
 * the envelope POST instead of adding @sentry/cloudflare.
 *
 * No-ops safely when VITE_SENTRY_DSN is unset - same convention as
 * sentryClient.ts and every other optional integration in this project.
 *
 * *.server.ts by this project's own naming convention (see
 * serverClient.server.ts, documentExtraction.ts's getDocumentExtractor()
 * lazy-import pattern): safe to import statically from other server-only
 * code, but any call site reachable from a component that also renders in
 * the browser must `await import("@/lib/observability/sentry.server")`
 * lazily instead, the same way vendorUploadRequests.ts lazily imports
 * serverClient.server.ts, so this never ends up in the client bundle.
 */

import { sendToSentry } from "./sentryEnvelope";

function readDsn(): string {
  return (import.meta.env["VITE_SENTRY_DSN"] as string | undefined)?.trim() ?? "";
}

/** See sentryClient.ts's readRelease() - same var, same fallback, read identically on both sides since Vite inlines VITE_-prefixed vars into the server/Workers bundle too. A future CI deploy step sets this from $GITHUB_SHA; nothing does yet (no CD pipeline - Task 13). */
function readRelease(): string {
  return (import.meta.env["VITE_RELEASE_SHA"] as string | undefined)?.trim() || "unknown";
}

function readEnvironment(): string {
  return import.meta.env.MODE || "unknown";
}

/**
 * Reports a server-side error to Sentry, tagged with the release SHA and
 * environment. Fire-and-forget and never throws - a Sentry delivery failure
 * must never turn into a second, unrelated failure on top of whatever this
 * was reporting.
 */
export function captureServerError(error: unknown, extra?: Record<string, unknown>): void {
  const dsn = readDsn();
  if (!dsn) return;

  void sendToSentry({
    dsn,
    error,
    release: readRelease(),
    environment: readEnvironment(),
    tags: { release: readRelease(), environment: readEnvironment() },
    ...(extra ? { extra } : {}),
  });
}
