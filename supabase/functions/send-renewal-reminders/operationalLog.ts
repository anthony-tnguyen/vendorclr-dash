// @ts-nocheck - runs in Supabase's Deno Edge Runtime, not the app's Node/
// TypeScript project (see index.ts's own header comment for why).
//
// Zero-import structured logging for this Edge Function, matching the shape
// of src/lib/observability/logger.server.ts's OperationalLog envelope
// (same field names, same redaction intent) without importing it - a
// *.server.ts file cannot cross the Node/Deno boundary any more than
// svixSignature.ts's own docblock explains for that file. This is a
// byte-for-byte-identical copy in each of the five Edge Function
// directories (resend-webhook, retry-failed-documents,
// send-renewal-reminders, process-document-jobs, compliance-housekeeping) -
// if one changes, check the other four.

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

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;
// Suffix must contain a digit - real key shapes always do, ordinary text
// after a short prefix like "re_"/"sk_" (e.g. "re_evaluate") never does.
const PREFIXED_SECRET_PATTERN = /\b(?:whsec|sk|pk|re|rk)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}\b/g;
const JWT_PATTERN = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const HEX_HASH_PATTERN = /\b[a-f0-9]{40,}\b/gi;
const FILENAME_PATTERN = /\b[\w.-]+\.(?:pdf|png|jpe?g|docx?|xlsx?|heic|tiff?)\b/gi;
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|api[_-]?key|policy[_-]?number|file[_-]?name|filename|email|document[_-]?text/i;

function redactString(value: string): string {
  return value
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(PREFIXED_SECRET_PATTERN, REDACTED)
    .replace(HEX_HASH_PATTERN, REDACTED)
    .replace(FILENAME_PATTERN, REDACTED);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Same JSON-line-to-console shape as logOperational() in logger.server.ts - Cloudflare captures console output as structured logs, and so does Supabase's Edge Function log viewer. */
export function logOperational(entry: OperationalLog, extra?: Record<string, unknown>): void {
  const payload = redact({ ...entry, ...(extra ? { extra } : {}) });
  const line = JSON.stringify(payload);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
}
