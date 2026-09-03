/**
 * Manual Svix webhook signature verification - the scheme Resend's own
 * webhooks use (Resend's docs point at Svix's, not their own, for the
 * cryptographic details: https://docs.svix.com/receiving/verifying-payloads/how-manual).
 * Verified against Svix's own published test vector before writing this
 * (secret `whsec_plJ3nmyCDGBKInavdOK15jsl`, id `msg_loFOjxBNrRLzqYUf`,
 * timestamp `1731705121`, body `{"event_type":"ping","data":{"success":true}}`
 * -> `v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=`), not guessed - see
 * src/tests/svix-signature.test.ts, which checks against that exact vector.
 *
 * Pure, no I/O, zero imports - only `atob`/`btoa`/`crypto.subtle`, identical
 * globals in Node/Bun and Deno. Unlike every other cross-runtime-boundary
 * file in this project (uploadTokens.ts, insuranceExtractionSchema.ts),
 * this one needs no npm:/jsr: specifier swap to run in
 * supabase/functions/resend-webhook - that copy is byte-for-byte this file.
 * If one changes, check the other.
 */

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Constant-time comparison, per Svix's own guidance, to avoid a timing side-channel on the signature check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function computeSignature(secret: string, signedContent: string): Promise<string> {
  const secretBytes = base64ToBytes(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedContent),
  );
  return bytesToBase64(new Uint8Array(signatureBytes));
}

/**
 * 5 minutes, matching Svix's own stated replay-protection guidance - long
 * enough for ordinary delivery jitter, short enough that a captured
 * request can't be replayed hours later.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface VerifyParams {
  secret: string;
  svixId: string;
  svixTimestamp: string;
  rawBody: string;
  svixSignature: string;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => number;
}

/**
 * Verifies one of Svix's rotatable v1 signatures in the svix-signature
 * header (space-separated `v1,<base64>` entries - Svix sends multiple
 * during a secret rotation window, any one matching is sufficient) against
 * the HMAC-SHA256 of `{id}.{timestamp}.{rawBody}` using the whsec_-prefixed
 * secret, and rejects a timestamp too far from now to guard against replay.
 */
export async function verifySvixSignature(params: VerifyParams): Promise<boolean> {
  const { secret, svixId, svixTimestamp, rawBody, svixSignature, now = Date.now } = params;

  const timestampSeconds = Number(svixTimestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(now() / 1000 - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = await computeSignature(secret, signedContent);

  for (const candidate of svixSignature.split(" ")) {
    const [version, sig] = candidate.split(",");
    if (version !== "v1" || !sig) continue;
    if (timingSafeEqual(sig, expected)) return true;
  }
  return false;
}
