/**
 * Structured server-side log envelope, plus real redaction - not a promise in
 * a docblock, a function with test cases (src/tests/observability.test.ts)
 * proving it actually strips what it claims to strip.
 *
 * Every server function, Edge Function and cron job in this project logs
 * through this one shape so a request can be traced across all three by
 * requestId alone. Two things intentionally do NOT go through this file:
 *
 *   - The three Deno Edge Functions (send-renewal-reminders,
 *     retry-failed-documents, resend-webhook) cannot import *.server.ts -
 *     they run on Deno, not Node/Workers, and are excluded from this
 *     project's Node typecheck (see their @ts-nocheck header). Each carries
 *     its own small, zero-import structured-logging helper matching this
 *     file's envelope shape and redaction rules, the same cross-runtime
 *     duplication convention already established by svixSignature.ts.
 *   - Sentry capture (sentry.server.ts/sentryClient.ts) is a separate
 *     concern (error tracking with stack traces, not structured operational
 *     events) and does not route through here, though both are called
 *     together at the few sites that need "log it AND capture it."
 */

export interface OperationalLog {
  level: "info" | "warn" | "error";
  event: string;
  requestId: string;
  companyId?: string;
  actorId?: string;
  route?: string;
  durationMs?: number;
  outcome: "success" | "failure";
  errorCode?: string;
}

const REDACTED = "[REDACTED]";

/** Generic bearer/API-key style tokens: "Bearer xxxx", "sk_live_xxx", "whsec_xxx", "re_xxx" (Resend), etc. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]+/gi;
// The suffix must contain at least one digit - real key shapes (base62/64
// random strings) virtually always do, and ordinary English text following
// a short prefix like "re_" or "sk_" (e.g. "re_evaluate", "sk_pending")
// never does. Caught by this file's own tests: an earlier version without
// the digit requirement redacted "re_evaluate the submission" whole.
const PREFIXED_SECRET_PATTERN = /\b(?:whsec|sk|pk|re|rk)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}\b/g;
/** JWTs - three base64url segments separated by dots, the shape a Supabase access/service-role token takes. */
const JWT_PATTERN = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
/** A bare sha256/sha1-shaped hex string - what hashToken()/hashFileBytes() produce (uploadTokens.ts) and what an upload token or token_hash could leak as. */
const HEX_HASH_PATTERN = /\b[a-f0-9]{40,}\b/gi;
/** Email addresses, wherever they show up - a vendor contact, a company owner, free text in an error message. */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
/** A filename with a common document extension - the one thing more likely to appear as a bare string than under a suspicious key name. */
const FILENAME_PATTERN = /\b[\w.-]+\.(?:pdf|png|jpe?g|docx?|xlsx?|heic|tiff?)\b/gi;

function redactString(value: string): string {
  return value
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(PREFIXED_SECRET_PATTERN, REDACTED)
    .replace(HEX_HASH_PATTERN, REDACTED)
    .replace(FILENAME_PATTERN, REDACTED);
}

/**
 * Keys whose VALUE is always replaced outright, whatever shape it is -
 * catches a policy number, a filename with an extension this file doesn't
 * recognize, or a document body that would never match a content pattern.
 * Matched by substring, case-insensitively, against camelCase or snake_case
 * key names (policyNumber, policy_number, file_name, documentText, ...) -
 * deliberately unanchored (no \b) so a camelCase compound like
 * "contactEmail" still matches, since "Email" has no word-boundary before it
 * for \b to catch. That same unanchored substring matching is exactly why
 * this list is kept to the redaction targets this project's plan actually
 * names (tokens, secrets, policy numbers, filenames, emails, document text)
 * and not broadened with shorter/looser terms - "ach" as a bare alternative
 * once matched inside "att-ACH-ments", a real false positive this file's
 * own test suite caught (src/tests/observability.test.ts).
 */
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|api[_-]?key|policy[_-]?number|file[_-]?name|filename|email|document[_-]?text/i;

const MAX_REDACT_DEPTH = 8;

/**
 * Deep-redacts a value for logging: an object's sensitive-named keys are
 * masked outright; every string (bare or nested) is scanned for an email
 * address, a bearer/prefixed secret, a JWT, a long hex hash, or a filename
 * with a document extension, each masked independently, so a value is never
 * exposed just because it arrived under an innocuous key name.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/** requestId for a fresh server function/route invocation - crypto.randomUUID() is available in both Node 19+/Bun and the Workers runtime. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Writes one structured, redacted log line to the platform's log sink
 * (console - Cloudflare Workers and `wrangler`/the Cloudflare dashboard both
 * capture console output as structured request logs; there is no separate
 * logging SDK configured in this project). `extra` is any additional
 * context worth keeping (e.g. a caught error's message) - passed separately
 * from OperationalLog's own fixed fields so a caller cannot accidentally
 * widen the envelope's shape, and redacted exactly the same way.
 */
export function logOperational(entry: OperationalLog, extra?: Record<string, unknown>): void {
  const payload = redact({ ...entry, ...(extra ? { extra } : {}) }) as Record<string, unknown>;
  const line = JSON.stringify(payload);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
}

/** Wraps an async server-function/route handler body, logging one success or failure envelope with a measured duration - the shape every call site in this project should use rather than hand-rolling try/timing/log. */
export async function withOperationalLog<T>(
  base: Omit<OperationalLog, "outcome" | "durationMs" | "errorCode">,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logOperational({ ...base, outcome: "success", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logOperational({
      ...base,
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      errorCode: error instanceof Error ? error.name : "unknown_error",
    });
    throw error;
  }
}
