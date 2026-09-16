/**
 * Browser-side Sentry error capture. See sentryEnvelope.ts's docblock for
 * why this hand-rolls the envelope POST rather than pulling in @sentry/react.
 *
 * Deliberately NOT named sentry.client.ts: this project's Vite config
 * (@lovable.dev/vite-tanstack-config, wrapping @tanstack/react-start's own
 * defaults) denies importing any `**\/*.client.*` file from the SERVER
 * build environment - confirmed empirically (`bun run build` failed with
 * "Denied by file pattern: **\/*.client.*" for src/routes/__root.tsx's
 * import of the file when it WAS named sentry.client.ts, since __root.tsx's
 * ErrorComponent is part of both the client AND server/SSR bundle). This
 * file needs to be reachable from exactly that isomorphic error boundary, so
 * it follows this codebase's own existing, working precedent for the same
 * situation - src/lib/lovable-error-reporting.ts - which is plain-named
 * (no .client. suffix) and guards itself with `typeof window === "undefined"`
 * at runtime instead of relying on a file-naming convention the bundler
 * enforces.
 *
 * No-ops safely when VITE_SENTRY_DSN is unset - no throw, no broken build,
 * no console spam - the same "detect unconfigured, skip gracefully"
 * convention this project already uses for every other optional integration
 * (getEmailSender()/getDocumentExtractor()/getMalwareScanner() all degrade
 * the same way when their own API key env var is unset). No real Sentry DSN
 * exists in this environment, so this path is exercised by its unit tests
 * (src/tests/observability.test.ts), not by a live Sentry project.
 *
 * Used from src/routes/__root.tsx's ErrorComponent, alongside - not instead
 * of - the existing reportLovableError() call and the existing user-safe
 * error page copy. Both are fire-and-forget telemetry side effects; neither
 * changes what the user sees.
 */

import { sendToSentry } from "./sentryEnvelope";

function readDsn(): string {
  return (import.meta.env["VITE_SENTRY_DSN"] as string | undefined)?.trim() ?? "";
}

/**
 * VITE_RELEASE_SHA is a build-time env var a future CI deploy step would set
 * from $GITHUB_SHA (no CD pipeline exists yet in this repo - Task 13 - so
 * nothing sets it today, and it correctly falls back to "unknown" for every
 * local dev/build right now). Vite inlines VITE_-prefixed vars at build time
 * into both the client and the SSR/Workers bundle, so sentry.server.ts reads
 * the exact same value via the exact same mechanism - see that file.
 */
function readRelease(): string {
  return (import.meta.env["VITE_RELEASE_SHA"] as string | undefined)?.trim() || "unknown";
}

/** Vite's own built-in mode ("development"/"production" by default) - no new env var needed for this tag. */
function readEnvironment(): string {
  return import.meta.env.MODE || "unknown";
}

/**
 * Reports an error to Sentry, tagged with the release SHA and environment.
 * Fire-and-forget: never throws, never blocks the caller on the network
 * request completing. A no-op on the server (typeof window check) - this is
 * specifically the browser-side reporter; sentry.server.ts is the
 * server-side equivalent, called from genuinely server-only code.
 */
export function captureClientError(error: unknown, extra?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;

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
