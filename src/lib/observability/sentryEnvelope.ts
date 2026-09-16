/**
 * Sentry error capture without the Sentry SDK.
 *
 * This app builds and deploys as a Cloudflare Worker (Nitro's
 * `cloudflare-module` preset - confirmed via `bun run build`, whose output
 * logs `[nitro] Building [Nitro] (preset: cloudflare-module...)` and emits
 * `.output/server/wrangler.json`). Plain `@sentry/node` is not guaranteed to
 * work there - it assumes Node APIs the Workers runtime does not fully
 * provide. `@sentry/cloudflare`/`@sentry/react` were the two SDKs suggested
 * for this, but this project already has an established alternative for
 * exactly this situation: a small, zero/minimal-dependency file that talks
 * the real wire protocol directly, matching svixSignature.ts (see that
 * file's own docblock). That is what this is - Sentry's envelope ingestion
 * API is a stable, documented HTTP format
 * (https://develop.sentry.dev/sdk/data-model/envelopes/), and both the
 * client and server sides only need `fetch`, `crypto.randomUUID()` and
 * `URL`, which are identical Web-standard globals in the browser and in the
 * Workers runtime - no dependency, no build-target risk, no bundle-size cost.
 * Chosen over adding @sentry/cloudflare + @sentry/react specifically to
 * avoid gambling two new SDKs against this project's less-common Vite +
 * Nitro(cloudflare-module) build combination when nothing here needs more
 * than "turn an error into one HTTP POST."
 *
 * Pure envelope-building lives here, shared by sentryClient.ts (browser
 * `fetch`) and sentry.server.ts (Workers `fetch`) - each owns its own DSN/
 * release/environment reading (import.meta.env, which this codebase already
 * reads from server-only files - see VITE_APP_URL in
 * vendorUploadRequests.ts - so the client bundle and the SSR/Workers bundle
 * both get it from the same Vite-injected source) and its own no-op-when-
 * unconfigured guard, but neither reimplements the wire format.
 */

export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "javascript";
  level: "error" | "warning" | "info";
  environment: string;
  release: string;
  message?: string;
  exception?: {
    values: Array<{ type: string; value: string; stacktrace?: { frames: unknown[] } }>;
  };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface ParsedDsn {
  /** The envelope ingestion endpoint to POST to, with sentry_key/sentry_version already in the query string. */
  envelopeUrl: string;
}

/**
 * A Sentry DSN looks like `https://<public_key>@<host>/<project_id>` (self-
 * hosted/org-routed DSNs may carry a path segment before the project id -
 * handled here by only ever treating the last path segment as the project
 * id). Returns null for anything that does not parse as a URL with both a
 * username and a project id - callers treat that exactly like "unconfigured"
 * rather than throwing, since a malformed DSN must never crash the thing it
 * was meant to help debug.
 */
export function parseDsn(dsn: string): ParsedDsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const publicKey = url.username;
  if (!publicKey) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!projectId) return null;
  const basePath = segments.length > 0 ? `/${segments.join("/")}` : "";
  const envelopeUrl = `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/?sentry_key=${encodeURIComponent(publicKey)}&sentry_version=7`;
  return { envelopeUrl };
}

/** 32 lowercase hex characters, no dashes - the event_id shape Sentry's envelope format requires (a plain crypto.randomUUID() is 36 characters and has dashes, so it is not itself valid here). */
export function generateSentryEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function buildErrorEvent(params: {
  error: unknown;
  release: string;
  environment: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}): SentryEvent {
  const { error, release, environment, tags, extra } = params;
  const errorObj = error instanceof Error ? error : new Error(String(error));

  return {
    event_id: generateSentryEventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment,
    release,
    exception: {
      values: [
        {
          type: errorObj.name || "Error",
          value: errorObj.message,
        },
      ],
    },
    // Spread rather than assigning `tags`/`extra` directly: exactOptionalPropertyTypes
    // treats `tags: undefined` as distinct from the key being absent entirely.
    ...(tags ? { tags } : {}),
    ...(extra ? { extra } : {}),
  };
}

/** Newline-delimited envelope framing: one header line, then one item-header/item-payload pair per item. This project only ever sends a single event item per envelope. */
export function buildEnvelope(event: SentryEvent, dsn: string): string {
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn,
  });
  const itemHeader = JSON.stringify({ type: "event", content_type: "application/json" });
  const itemPayload = JSON.stringify(event);
  return `${header}\n${itemHeader}\n${itemPayload}\n`;
}

/**
 * Fire-and-forget: builds and POSTs the envelope, swallowing any failure
 * (a network error reaching Sentry must never surface as an application
 * error, the same "never blocks, never throws" rule every optional
 * integration in this project already follows - see getEmailSender(),
 * getDocumentExtractor(), getMalwareScanner()). Returns nothing meaningful
 * to await on for that reason; callers that want to be sure delivery was
 * attempted before e.g. a Worker suspends can still `await` it.
 */
export async function sendToSentry(params: {
  dsn: string;
  error: unknown;
  release: string;
  environment: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}): Promise<void> {
  const parsed = parseDsn(params.dsn);
  if (!parsed) return;

  const event = buildErrorEvent(params);
  const body = buildEnvelope(event, params.dsn);

  try {
    await fetch(parsed.envelopeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
    });
  } catch {
    // Never let a Sentry delivery failure become a second, user-visible error.
  }
}
