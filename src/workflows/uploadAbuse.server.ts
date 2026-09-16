/**
 * Abuse controls for the anonymous vendor-upload portal (resolveUploadToken()
 * and uploadDocumentForToken() in vendorUploadRequests.ts) - the one surface
 * in this app any stranger on the internet can call with no session, gated
 * only by a token they either have or are guessing. This file adds three
 * independent layers in front of it:
 *
 *   1. Atomic, DB-backed rate limits (see the migration this file's
 *      counters live in: 20260916000200_upload_abuse_controls.sql) - the
 *      hard, always-enforced boundary. Five limits, matching this task's
 *      checklist exactly:
 *        - 20 resolves / IP / 10 minutes
 *        - 10 uploads / IP / 15 minutes
 *        -  5 invalid-token attempts / IP / 10 minutes
 *        -  5 uploads / token / 15 minutes
 *        - 250 uploads / company / 24 hours
 *   2. An optional Turnstile "prove you're not a bot" soft gate, once an
 *      IP crosses a WARNING threshold below its hard limit - see
 *      CaptchaRequiredError's own docblock for the exact contract this
 *      leaves for a future UI-owning task.
 *   3. Structured logging (src/lib/observability/logger.server.ts, Task 2)
 *      of every throttle and every captcha challenge - detailed enough for
 *      an operator to see what's happening, while the error actually
 *      THROWN back to the anonymous caller stays generic. This is the same
 *      discipline resolveUploadToken()'s own INVALID_TOKEN_MESSAGE already
 *      follows for a different reason (never telling a caller whether a
 *      token exists) - this file's throttle/captcha errors never mention a
 *      token at all, so they cannot leak that fact either way.
 *
 * IP addresses are never stored raw. hmacIpAddress() HMAC-SHA256s the caller's
 * IP with a server-only secret (UPLOAD_ABUSE_IP_HMAC_SECRET) before it ever
 * becomes part of a bucket_key written to Postgres - see
 * getUploadAbuseIpHmacSecret()'s own docblock for why a missing secret fails
 * closed rather than silently disabling rate limiting.
 */

export interface AssertUploadAllowedInput {
  operation: "resolve" | "upload" | "invalid_token";
  ipAddress: string;
  /** sha256 of the plaintext upload token (hashToken() in uploadTokens.ts) - only meaningful, and only checked, for "upload". */
  tokenHash?: string;
  /** Only meaningful, and only checked, for "upload" - the 250/day company-wide budget. */
  companyId?: string;
  /**
   * A Turnstile response token the caller already collected and wants
   * verified. Optional today: no UI in this codebase solicits one yet (see
   * CaptchaRequiredError's docblock) - a future UI-owning task passes this
   * on a retry after the vendor solves the challenge CaptchaRequiredError
   * signaled.
   */
  captchaToken?: string;
}

/**
 * Thrown when a hard limit has already been exceeded. Message is
 * deliberately generic - it names no limit, no bucket, no token - so an
 * anonymous caller (and a hostile one deliberately timing responses) cannot
 * learn *which* of the five limits tripped, let alone anything about
 * whether a specific token exists. Every call site in vendorUploadRequests.ts
 * lets this propagate as-is rather than rewrapping it.
 */
export class UploadThrottledError extends Error {
  constructor() {
    super("Too many attempts. Please wait a few minutes and try again.");
    this.name = "UploadThrottledError";
  }
}

/**
 * Thrown once an IP-scoped rate limit crosses THROTTLE_WARNING_RATIO of its
 * hard limit, below the hard limit itself, and Turnstile is configured
 * (TURNSTILE_SECRET_KEY set) - a soft gate a caller can clear by supplying a
 * verified `captchaToken` on retry, unlike UploadThrottledError which cannot
 * be cleared at all until the window rolls over.
 *
 * The contract this leaves for a future UI-owning task (no src/features/**
 * or src/routes/** file is part of this task's own file list, so no widget
 * is built here):
 *
 *   1. Catch this error at the call site (resolveUploadToken() /
 *      uploadDocumentForToken()) or in the UI layer calling them.
 *   2. Render a Cloudflare Turnstile widget (a site key - NOT the secret
 *      key this file reads - would need to be exposed to the browser,
 *      VITE_-prefixed, e.g. VITE_TURNSTILE_SITE_KEY; nothing in this
 *      session has a real Turnstile account, so no site key is invented or
 *      wired up here).
 *   3. Once the vendor solves it, retry the original call
 *      (resolveUploadToken()/uploadDocumentForToken()) with the widget's
 *      response token attached as `captchaToken`.
 *   4. This file's verifyTurnstileToken() does the actual server-side
 *      verification against Cloudflare's siteverify endpoint - a UI layer
 *      never verifies a Turnstile token itself, it only collects one.
 *
 * Only IP-scoped rules (resolve:ip, upload:ip, invalid_token:ip) can ever
 * trigger this - a per-token or per-company limit says nothing about
 * whether the caller is a human, so neither is a captcha-eligible signal.
 */
export class CaptchaRequiredError extends Error {
  constructor() {
    super("Please complete the verification challenge and try again.");
    this.name = "CaptchaRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Named limits - every number in the checklist gets a name, not a bare
// literal scattered through rulesFor() below.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const RESOLVE_IP_LIMIT = 20;
export const RESOLVE_IP_WINDOW_MS = 10 * MINUTE_MS;

export const UPLOAD_IP_LIMIT = 10;
export const UPLOAD_IP_WINDOW_MS = 15 * MINUTE_MS;

export const INVALID_TOKEN_IP_LIMIT = 5;
export const INVALID_TOKEN_IP_WINDOW_MS = 10 * MINUTE_MS;

export const UPLOAD_TOKEN_LIMIT = 5;
export const UPLOAD_TOKEN_WINDOW_MS = 15 * MINUTE_MS;

export const UPLOAD_COMPANY_DAILY_LIMIT = 250;
export const UPLOAD_COMPANY_WINDOW_MS = 24 * HOUR_MS;

/** Fraction of an IP-scoped rule's hard limit at which CaptchaRequiredError starts firing (when Turnstile is configured) - below this, a caller proceeds with no challenge at all. */
export const THROTTLE_WARNING_RATIO = 0.5;

// ---------------------------------------------------------------------------
// extractClientIp() - pure, no framework/DB dependency, separately testable
// against a plain Headers-like object. The one piece of "how do I find the
// caller's real IP inside a createServerFn handler" this file needs; the
// TanStack Start-specific half (actually reading the incoming Request) lives
// at the vendorUploadRequests.ts call site (getRequest() from
// "@tanstack/react-start/server"), verified empirically in
// src/tests/upload-abuse.test.ts against a real request context, not just
// assumed from the framework's types.
// ---------------------------------------------------------------------------

/**
 * cf-connecting-ip is Cloudflare's own header, set by their edge on every
 * request that reaches a Worker - not spoofable by the client, since
 * Cloudflare overwrites it regardless of what a client sends, which is
 * exactly why it is checked first and trusted outright. x-forwarded-for is
 * the fallback for local dev (`wrangler dev`/`bun run dev`), where no
 * Cloudflare edge sits in front of the request at all and cf-connecting-ip
 * is simply absent - only its FIRST entry is used (the original client, by
 * convention; every proxy after that appends its own address to the same
 * header) and it is not treated as authoritative the way cf-connecting-ip
 * is, since an arbitrary client can set x-forwarded-for to anything when
 * nothing in front of the app is stripping/rewriting it. A request with
 * neither header (the common local case with no proxy at all) falls back to
 * a fixed "unknown" bucket, shared by every such caller - a real but
 * accepted limitation of local dev, not production, where Cloudflare always
 * sets cf-connecting-ip.
 */
export function extractClientIp(headers: { get(name: string): string | null }): string {
  const cfConnectingIp = headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// HMAC-digested IP keys
// ---------------------------------------------------------------------------

/**
 * Server-only secret salting every HMAC'd IP key this file writes to
 * Postgres. Fails CLOSED when unset - throws immediately, rather than
 * falling back to an unsalted hash or, worse, skipping rate limiting
 * outright - because IP-based rate limiting is this task's actual security
 * control, not an optional enhancement like email or extraction that this
 * project's other providers gracefully no-op without. A silent fallback
 * here (e.g. "no secret configured, so don't rate-limit") would quietly
 * defeat the entire point of this task the moment someone forgot to set one
 * env var; a loud, immediate throw at first call is the safer failure mode,
 * consistent with getServiceRoleClient() throwing outright when
 * VENDORCLEAR_SERVICE_ROLE_KEY is unset for the very same reason - and this
 * endpoint already cannot function without Supabase reachable at all, so
 * this does not introduce a new class of fragility beyond what
 * resolveUploadToken()/uploadDocumentForToken() already have.
 */
export function getUploadAbuseIpHmacSecret(): string {
  const secret = process.env["UPLOAD_ABUSE_IP_HMAC_SECRET"]?.trim();
  if (!secret) {
    throw new Error(
      "UPLOAD_ABUSE_IP_HMAC_SECRET must be set to enable upload abuse protections. " +
        "See .env.example.",
    );
  }
  return secret;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * HMAC-SHA256 of `value` under `secret`, hex-encoded. Web Crypto only
 * (`crypto.subtle`), same cross-runtime reasoning uploadTokens.ts documents
 * for its own hashToken()/hashFileBytes(): this must run identically in
 * Node dev and the Cloudflare Workers production runtime.
 */
async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(new Uint8Array(signature));
}

/** The digest actually written into a bucket_key for an IP-scoped rule - never the raw IP itself. */
export async function hmacIpAddress(ipAddress: string): Promise<string> {
  return hmacHex(getUploadAbuseIpHmacSecret(), ipAddress);
}

// ---------------------------------------------------------------------------
// Fixed-window bucketing - pure, testable independent of any DB call.
// ---------------------------------------------------------------------------

/** The start (ms since epoch) of the fixed window of length windowMs that `nowMs` falls into. */
export function computeWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

// ---------------------------------------------------------------------------
// Turnstile server-side verification
// ---------------------------------------------------------------------------

const TURNSTILE_VERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * POSTs a Turnstile response token to Cloudflare's siteverify endpoint.
 * Returns false (never throws) whenever verification cannot be considered
 * successful - no secret configured, no token given, a non-2xx response, a
 * malformed body, or a network failure all collapse to "not verified,"
 * because the only two things a caller of this ever needs to know are
 * "proceed" or "don't." TURNSTILE_SECRET_KEY unset is not a "gracefully
 * degrade and let everyone through" case the way this project's other
 * optional providers work: assertUploadAllowed() below only ever calls this
 * when Turnstile IS configured (see isTurnstileConfigured()) - when it
 * isn't, the CaptchaRequiredError gate is skipped entirely upstream, so
 * this function returning false when unconfigured is simply correct/unused
 * dead-code-safety, not a path any real caller exercises.
 */
export async function verifyTurnstileToken(token: string): Promise<boolean> {
  const secret = process.env["TURNSTILE_SECRET_KEY"]?.trim();
  if (!secret || !token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    const response = await fetch(TURNSTILE_VERIFY_ENDPOINT, { method: "POST", body });
    if (!response.ok) return false;
    const json = (await response.json().catch(() => null)) as { success?: boolean } | null;
    return json?.success === true;
  } catch {
    return false;
  }
}

function isTurnstileConfigured(): boolean {
  return Boolean(process.env["TURNSTILE_SECRET_KEY"]?.trim());
}

// ---------------------------------------------------------------------------
// The service-role client and the atomic increment RPC
// ---------------------------------------------------------------------------

/**
 * Loaded lazily, not statically imported: this module is itself lazily
 * imported from vendorUploadRequests.ts's handler bodies (a module client
 * components import), so a static import here would put serverClient.server
 * back into the client bundle's import graph - the same reasoning every
 * other *.server module in this project already documents at its own
 * lazy-import call site.
 *
 * The dynamic import() itself is memoized (one in-flight promise shared by
 * every caller) rather than re-invoked per call: assertUploadAllowed()
 * checks every applicable rule concurrently (Promise.all in rulesFor()'s
 * caller below), so a single "upload" call can already fire two or three
 * simultaneous getServiceRoleClient() calls, and real traffic can have many
 * such calls in flight across different requests at once on a Workers
 * instance. One shared import() avoids redundant module resolution under
 * that concurrency rather than relying on the module loader to coalesce it.
 */
let serverClientModule: Promise<typeof import("@/lib/supabase/serverClient.server")> | null = null;
async function getServiceRoleClient() {
  if (!serverClientModule) {
    serverClientModule = import("@/lib/supabase/serverClient.server");
  }
  const mod = await serverClientModule;
  return mod.getServiceRoleClient();
}

/**
 * Calls increment_upload_rate_limit_counter() (migration
 * 20260916000200_upload_abuse_controls.sql) for one bucket/window, returning
 * the post-increment count. Throws on an unexpected DB error rather than
 * treating it as "not rate limited" - failing open here would silently
 * defeat the rate limit the same way a missing HMAC secret would; see this
 * file's docblock and getUploadAbuseIpHmacSecret()'s for the same reasoning
 * applied to a different failure mode. This does not introduce a new single
 * point of failure: resolveUploadToken()/uploadDocumentForToken() already
 * cannot do anything useful without Supabase reachable.
 */
async function incrementCounter(
  bucketKey: string,
  windowMs: number,
  nowMs: number,
): Promise<number> {
  const windowStart = new Date(computeWindowStart(nowMs, windowMs)).toISOString();
  const supabase = await getServiceRoleClient();
  const { data, error } = await supabase.rpc("increment_upload_rate_limit_counter", {
    p_bucket_key: bucketKey,
    p_window_start: windowStart,
  });

  if (error) {
    throw new Error(`upload rate limit counter failed for bucket "${bucketKey}": ${error.message}`);
  }
  return data as number;
}

// ---------------------------------------------------------------------------
// Structured logging - detailed here; the error thrown back to the caller
// stays generic (see UploadThrottledError/CaptchaRequiredError above).
// ---------------------------------------------------------------------------

async function logAbuseEvent(params: {
  event: "upload_abuse_throttled" | "upload_abuse_captcha_required";
  operation: AssertUploadAllowedInput["operation"];
  bucketPrefix: string;
  count: number;
  limit: number;
}): Promise<void> {
  const { logOperational, newRequestId } = await import("@/lib/observability/logger.server");
  logOperational(
    {
      level: "warn",
      event: params.event,
      requestId: newRequestId(),
      outcome: "failure",
      errorCode: params.bucketPrefix,
    },
    { operation: params.operation, count: params.count, limit: params.limit },
  );
}

// ---------------------------------------------------------------------------
// Rule selection per operation - exactly the five limits in the checklist,
// no more, no fewer, applied per operation as the checklist itself groups
// them.
// ---------------------------------------------------------------------------

interface RateLimitRule {
  /** Identifies the limit itself for logging (never the identity being limited) - e.g. "resolve:ip", "upload:token". */
  bucketPrefix: string;
  /** The HMAC'd IP, the token hash, or the company id - whichever identity this rule scopes to. */
  identityKey: string;
  windowMs: number;
  limit: number;
  /** Only an IP-scoped rule can ever trigger CaptchaRequiredError - see that class's own docblock. */
  captchaEligible: boolean;
}

async function rulesFor(input: AssertUploadAllowedInput): Promise<RateLimitRule[]> {
  const ipKey = await hmacIpAddress(input.ipAddress);

  if (input.operation === "resolve") {
    return [
      {
        bucketPrefix: "resolve:ip",
        identityKey: ipKey,
        windowMs: RESOLVE_IP_WINDOW_MS,
        limit: RESOLVE_IP_LIMIT,
        captchaEligible: true,
      },
    ];
  }

  if (input.operation === "invalid_token") {
    return [
      {
        bucketPrefix: "invalid_token:ip",
        identityKey: ipKey,
        windowMs: INVALID_TOKEN_IP_WINDOW_MS,
        limit: INVALID_TOKEN_IP_LIMIT,
        captchaEligible: true,
      },
    ];
  }

  // "upload"
  const rules: RateLimitRule[] = [
    {
      bucketPrefix: "upload:ip",
      identityKey: ipKey,
      windowMs: UPLOAD_IP_WINDOW_MS,
      limit: UPLOAD_IP_LIMIT,
      captchaEligible: true,
    },
  ];
  if (input.tokenHash) {
    rules.push({
      bucketPrefix: "upload:token",
      identityKey: input.tokenHash,
      windowMs: UPLOAD_TOKEN_WINDOW_MS,
      limit: UPLOAD_TOKEN_LIMIT,
      captchaEligible: false,
    });
  }
  if (input.companyId) {
    rules.push({
      bucketPrefix: "upload:company",
      identityKey: input.companyId,
      windowMs: UPLOAD_COMPANY_WINDOW_MS,
      limit: UPLOAD_COMPANY_DAILY_LIMIT,
      captchaEligible: false,
    });
  }
  return rules;
}

/**
 * Checks-and-increments (atomically, per rule) every rate limit that
 * applies to `input.operation`, given whatever identity fields the caller
 * supplied, then decides:
 *
 *   1. Any rule's post-increment count exceeds its limit -> throws
 *      UploadThrottledError (generic - see that class's own docblock).
 *   2. Otherwise, if Turnstile is configured and any CAPTCHA-eligible rule's
 *      count has crossed THROTTLE_WARNING_RATIO of its limit, and
 *      `input.captchaToken` either wasn't supplied or doesn't verify ->
 *      throws CaptchaRequiredError.
 *   3. Otherwise resolves normally - the caller may proceed.
 *
 * Every applicable rule is incremented every call, even once one has
 * already breached its limit - a monotonic counter with no cap on how far
 * over it can go costs nothing extra and keeps this function's DB calls
 * simple (one Promise.all round of independent, per-rule atomic RPCs)
 * rather than needing to short-circuit.
 */
export async function assertUploadAllowed(input: AssertUploadAllowedInput): Promise<void> {
  const rules = await rulesFor(input);
  const now = Date.now();

  const results = await Promise.all(
    rules.map(async (rule) => ({
      rule,
      count: await incrementCounter(`${rule.bucketPrefix}:${rule.identityKey}`, rule.windowMs, now),
    })),
  );

  const breached = results.find((r) => r.count > r.rule.limit);
  if (breached) {
    await logAbuseEvent({
      event: "upload_abuse_throttled",
      operation: input.operation,
      bucketPrefix: breached.rule.bucketPrefix,
      count: breached.count,
      limit: breached.rule.limit,
    });
    throw new UploadThrottledError();
  }

  if (!isTurnstileConfigured()) return;

  const warning = results.find(
    (r) => r.rule.captchaEligible && r.count >= r.rule.limit * THROTTLE_WARNING_RATIO,
  );
  if (!warning) return;

  const solved = input.captchaToken ? await verifyTurnstileToken(input.captchaToken) : false;
  if (solved) return;

  await logAbuseEvent({
    event: "upload_abuse_captcha_required",
    operation: input.operation,
    bucketPrefix: warning.rule.bucketPrefix,
    count: warning.count,
    limit: warning.rule.limit,
  });
  throw new CaptchaRequiredError();
}
