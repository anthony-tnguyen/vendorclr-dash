/**
 * Byte-for-byte the same helpers as src/workflows/uploadTokens.ts. Duplicated
 * rather than imported: this function runs in Supabase's Deno Edge Runtime,
 * a separate deployment target from the Node/Cloudflare app, and there is no
 * shared build step across that boundary in this project. Both files use
 * only Web Crypto and btoa, which are identical globals in both runtimes -
 * if one changes, check the other.
 */

const TOKEN_BYTES = 32;

/** How long a vendor has to act on an upload request before it lapses. Matches uploadTokens.ts. */
export const UPLOAD_REQUEST_TTL_DAYS = 14;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateUploadToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function newExpiryDate(from: Date = new Date()): Date {
  const expires = new Date(from);
  expires.setUTCDate(expires.getUTCDate() + UPLOAD_REQUEST_TTL_DAYS);
  return expires;
}
