/**
 * Server-side file-CONTENT validation for vendor uploads: verifies the real
 * byte signature of an uploaded file rather than trusting the browser-
 * supplied File.type (which a client fully controls), and - for a PDF
 * specifically - inspects enough of its structure to flag password
 * protection before the file reaches storage, malware scanning or
 * extraction.
 *
 * ".server.ts" by filename suffix only, not by directory: this project's
 * Vite config (@lovable.dev/vite-tanstack-config) denies anything under a
 * "**\/server/**" DIRECTORY from the client bundle - a *.server.ts file
 * sitting in src/workflows/ (not src/server/) is not itself denied by that
 * glob, the same convention src/lib/supabase/serverClient.server.ts and
 * src/lib/observability/logger.server.ts already rely on. This file has no
 * server-only secret to leak (it does no I/O of its own - no DB, no
 * network, pure byte inspection over an ArrayBuffer), but it is still
 * lazily imported from vendorUploadRequests.ts's handler bodies, the same
 * pattern every other server-only module in that file already follows, so
 * it never becomes a reason a future refactor accidentally pulls
 * uploadDocumentForToken()'s other server-only imports into the client
 * bundle's static import graph.
 */

import type { AllowedUploadMimeType } from "./uploadTokens";

export interface ValidatedUpload {
  bytes: ArrayBuffer;
  detectedMime: AllowedUploadMimeType;
  /**
   * True when a PDF's trailer carries an /Encrypt entry - see
   * pdfAppearsEncrypted() below. Deliberately NOT thrown as an error from
   * this function: the byte signature is still a genuine, supported PDF,
   * so the caller (uploadDocumentForToken()) decides what to do with that
   * fact - reject with a vendor-facing "remove the password and re-upload"
   * message, distinguishable to operations via a specific error code, per
   * this task's own checklist. Always false for a JPEG/PNG.
   */
  encryptedPdf: boolean;
}

/** Every rejection this module produces carries a `code` so a caller (and its structured log) can tell them apart without parsing the message text. */
export type FileValidationErrorCode = "empty_file" | "unsupported_type" | "mime_mismatch";

export class FileValidationError extends Error {
  readonly code: FileValidationErrorCode;
  constructor(code: FileValidationErrorCode, message: string) {
    super(message);
    this.name = "FileValidationError";
    this.code = code;
  }
}

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matchesSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * The real magic-byte sniff, independent of whatever File.type claims.
 * Exported so both validateUploadedFile() and its own tests can call it
 * directly against raw bytes without needing a real File object. Order
 * matters only in that PDF/PNG signatures are checked before JPEG's - JPEG's
 * three-byte signature is short enough that checking it first would still
 * be correct (PDF/PNG's longer, distinct signatures can never collide with
 * it), but ordering the longer, more specific signatures first keeps the
 * intent readable.
 */
export function detectSignature(bytes: ArrayBuffer): AllowedUploadMimeType | null {
  const view = new Uint8Array(bytes);
  if (matchesSignature(view, PDF_SIGNATURE)) return "application/pdf";
  if (matchesSignature(view, PNG_SIGNATURE)) return "image/png";
  if (matchesSignature(view, JPEG_SIGNATURE)) return "image/jpeg";
  return null;
}

/**
 * Flags a PDF whose trailer dictionary carries an /Encrypt entry - the
 * byte-level signal essentially every PDF writer (Acrobat included) emits
 * for a password-protected or otherwise encrypted document. Deliberately
 * not a full PDF parser - this project has none by design (see
 * documentExtraction.ts's own "No OCR, no pdf-parse" note in
 * supabase/README.md) - a PDF's trailer dictionary is plain, searchable
 * ASCII even inside an otherwise binary file, so a literal byte search for
 * "/Encrypt" is a reliable, lightweight signal without walking the xref
 * table or building a real parser. A false positive (a content stream that
 * happens to contain the literal bytes "/Encrypt" without being a real
 * trailer key) is possible in theory but vanishingly unlikely in a genuine
 * certificate of insurance, and the failure direction is the safe one: the
 * vendor is asked to remove a password that may not exist, never the
 * reverse (an actually-encrypted file silently accepted).
 */
export function pdfAppearsEncrypted(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  const needle = new TextEncoder().encode("/Encrypt");
  outer: for (let i = 0; i <= view.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (view[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Validates an uploaded File's real content. Throws FileValidationError for:
 *
 *   - "empty_file" - zero bytes (uploadDocumentForToken() already rejects
 *     this via file.size before this function is ever called - see that
 *     function's own pre-check - this is defense in depth against a lying
 *     Content-Length, not this function's primary job).
 *   - "unsupported_type" - the byte signature matches none of the three
 *     allowed types, whatever File.type claims.
 *   - "mime_mismatch" - File.type was set (not every caller sets it) and
 *     disagrees with the real detected signature. An empty/missing
 *     File.type is not treated as a mismatch - the detected signature wins
 *     outright, and callers should use `detectedMime`, not the original
 *     File.type, for anything downstream (storage content-type, the
 *     vendor_documents.mime_type column) from here on.
 *
 * Never throws for an encrypted PDF - see ValidatedUpload.encryptedPdf's
 * own docblock for why that is a return value, not an exception, here.
 */
export async function validateUploadedFile(file: File): Promise<ValidatedUpload> {
  const bytes = await file.arrayBuffer();

  if (bytes.byteLength === 0) {
    throw new FileValidationError("empty_file", "The uploaded file is empty.");
  }

  const detectedMime = detectSignature(bytes);
  if (!detectedMime) {
    throw new FileValidationError(
      "unsupported_type",
      "This file's content doesn't match a supported PDF, JPG, or PNG. Upload a certificate of insurance in one of those formats.",
    );
  }

  if (file.type && file.type !== detectedMime) {
    throw new FileValidationError(
      "mime_mismatch",
      `This file was uploaded as "${file.type}" but its actual content is ${detectedMime}. Upload a genuine PDF, JPG, or PNG.`,
    );
  }

  return {
    bytes,
    detectedMime,
    encryptedPdf: detectedMime === "application/pdf" && pdfAppearsEncrypted(bytes),
  };
}
