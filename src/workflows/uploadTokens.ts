/**
 * Pure logic for vendor upload-request tokens: no database, no network, no
 * TanStack Start server-function context. Kept separate from
 * vendorUploadRequests.ts so the security-critical pieces - token
 * generation, hashing, expiry, the storage path shape - are unit-testable
 * without spinning up Postgres or a server function runtime.
 *
 * Uses only Web Crypto (`crypto.getRandomValues`, `crypto.subtle.digest`) and
 * `btoa`, all of which are global in Node, browsers, and Cloudflare Workers -
 * the app builds against Cloudflare via nitro (see vite.config.ts), so this
 * deliberately avoids `node:crypto` and `Buffer`.
 */

/** Raw entropy in the token. 32 bytes = 256 bits, same order as a UUID v4 pair. */
const TOKEN_BYTES = 32;

/** How long a vendor has to act on an upload request before it lapses. */
export const UPLOAD_REQUEST_TTL_DAYS = 14;

const MIME_EXTENSIONS = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

/**
 * The three content types a byte signature can ever resolve to - shared
 * with fileValidation.server.ts's validateUploadedFile() so the "what's
 * allowed" vocabulary is defined in exactly one place, not duplicated as a
 * second hard-coded union there. Deliberately the same three keys as
 * MIME_EXTENSIONS: a mime type this app accepts always has a known storage
 * extension, and vice versa.
 */
export type AllowedUploadMimeType = keyof typeof MIME_EXTENSIONS;

// Deliberately string[], not AllowedUploadMimeType[]: existing callers (e.g.
// VendorUploadPortal.tsx's client-side pre-check) call
// .includes(file.type), and file.type is a plain string - narrowing this
// array's element type would just push a cast onto every such call site for
// no real safety gain, since the check itself is exactly what's proving
// membership.
export const ALLOWED_UPLOAD_MIME_TYPES: string[] = Object.keys(MIME_EXTENSIONS);

/** Matches the bucket's file_size_limit in the migration - keep these in sync. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates the plaintext token that goes in the magic-link URL. Callers must
 * hash it with `hashToken()` before storing anything - the plaintext exists
 * only for the length of one request/response cycle.
 */
export function generateUploadToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * SHA-256 of the token, hex-encoded. What actually lives in
 * vendor_upload_requests.token_hash - if that table leaked, the tokens
 * themselves could not be reconstructed from it.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/** SHA-256 of uploaded file bytes, for the vendor_documents.sha256 duplicate-detection column. */
export async function hashFileBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export function extensionForMimeType(mimeType: string): string | null {
  return (MIME_EXTENSIONS as Record<string, string>)[mimeType] ?? null;
}

export function isAllowedUploadMimeType(mimeType: string): boolean {
  return mimeType in MIME_EXTENSIONS;
}

/**
 * The server-controlled storage path, per the design decision in the review
 * this Phase implements: never trust a client-supplied file name or path.
 * `documentId` is generated server-side before the object is written, so the
 * path and the vendor_documents.id it will be inserted under always match.
 */
export function buildStoragePath(params: {
  companyId: string;
  vendorId: string;
  documentId: string;
  mimeType: string;
}): string {
  const ext = extensionForMimeType(params.mimeType);
  if (!ext) throw new Error(`Unsupported mime type: ${params.mimeType}`);
  return `company/${params.companyId}/vendor/${params.vendorId}/documents/${params.documentId}.${ext}`;
}

export function newExpiryDate(from: Date = new Date()): Date {
  const expires = new Date(from);
  expires.setUTCDate(expires.getUTCDate() + UPLOAD_REQUEST_TTL_DAYS);
  return expires;
}

export function isExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

/** Statuses an upload request can be resolved or uploaded to from. Anything else is terminal or not-yet-sent. */
const OPENABLE_STATUSES = new Set(["pending", "email_sent", "opened"]);
const UPLOADABLE_STATUSES = new Set(["pending", "email_sent", "opened", "needs_review"]);
/**
 * Same members as OPENABLE_STATUSES today, but a distinct set on purpose:
 * "the vendor can still open this link" and "an admin can still call this
 * ask off" are different questions that happen to share an answer right
 * now. Once the vendor has acted at all - even just uploading something
 * that then needs review - the request has been fulfilled or is being
 * worked, not something to cancel; the admin action there is reprocessing
 * or the review screen, not this.
 */
const CANCELLABLE_STATUSES = new Set(["pending", "email_sent", "opened"]);

export function canOpenRequest(status: string): boolean {
  return OPENABLE_STATUSES.has(status);
}

export function canUploadToRequest(status: string): boolean {
  return UPLOADABLE_STATUSES.has(status);
}

export function canCancelRequest(status: string): boolean {
  return CANCELLABLE_STATUSES.has(status);
}
