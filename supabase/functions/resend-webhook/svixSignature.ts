/**
 * Byte-for-byte the same as src/workflows/svixSignature.ts - that is the
 * canonical, unit-tested copy (src/tests/svix-signature.test.ts, checked
 * against Svix's own published test vector). Duplicated here only because
 * this function runs in Supabase's Deno Edge Runtime with no shared build
 * step across that boundary - not because the code itself needs to differ;
 * it uses only `atob`/`btoa`/`crypto.subtle`, identical globals in both
 * runtimes, unlike uploadTokens.ts/insuranceExtractionSchema.ts which at
 * least need an npm:/jsr: specifier swap. If one changes, check the other.
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
