import { describe, expect, it } from "vitest";

import {
  buildStoragePath,
  canCancelRequest,
  canOpenRequest,
  canUploadToRequest,
  extensionForMimeType,
  generateUploadToken,
  hashFileBytes,
  hashToken,
  isAllowedUploadMimeType,
  isExpired,
  MAX_UPLOAD_BYTES,
  newExpiryDate,
  UPLOAD_REQUEST_TTL_DAYS,
} from "@/workflows/uploadTokens";

describe("generateUploadToken", () => {
  it("produces a URL-safe token with no padding", () => {
    const token = generateUploadToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateUploadToken));
    expect(tokens.size).toBe(200);
  });

  it("carries at least 256 bits of entropy", () => {
    // base64url encodes 6 bits/char; 32 raw bytes needs at least 43 characters.
    expect(generateUploadToken().length).toBeGreaterThanOrEqual(43);
  });
});

describe("hashToken", () => {
  it("is deterministic", async () => {
    const token = generateUploadToken();
    expect(await hashToken(token)).toBe(await hashToken(token));
  });

  it("differs for different tokens", async () => {
    const a = await hashToken(generateUploadToken());
    const b = await hashToken(generateUploadToken());
    expect(a).not.toBe(b);
  });

  it("is 64 lowercase hex characters (SHA-256)", async () => {
    const hash = await hashToken(generateUploadToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cannot be reversed into the token by inspection", async () => {
    const token = "obviously-not-a-real-token-but-still";
    const hash = await hashToken(token);
    expect(hash).not.toContain(token);
  });
});

describe("hashFileBytes", () => {
  it("matches the known SHA-256 of an empty buffer", async () => {
    const hash = await hashFileBytes(new ArrayBuffer(0));
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("differs for different content", async () => {
    const a = await hashFileBytes(new TextEncoder().encode("certificate-a").buffer);
    const b = await hashFileBytes(new TextEncoder().encode("certificate-b").buffer);
    expect(a).not.toBe(b);
  });
});

describe("mime type handling", () => {
  it("maps every allowed mime type to a file extension", () => {
    for (const mime of ["application/pdf", "image/jpeg", "image/png"]) {
      expect(isAllowedUploadMimeType(mime)).toBe(true);
      expect(extensionForMimeType(mime)).toBeTruthy();
    }
  });

  it("rejects mime types outside the allow-list", () => {
    // DOC/DOCX intentionally unsupported for certificates of insurance.
    for (const mime of ["application/msword", "text/html", "application/zip"]) {
      expect(isAllowedUploadMimeType(mime)).toBe(false);
      expect(extensionForMimeType(mime)).toBeNull();
    }
  });

  it("defines a size limit worth enforcing", () => {
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(0);
    expect(MAX_UPLOAD_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024);
  });
});

describe("buildStoragePath", () => {
  it("builds the server-controlled path shape, ignoring any client input", () => {
    const path = buildStoragePath({
      companyId: "co-1",
      vendorId: "vnd-1",
      documentId: "doc-1",
      mimeType: "application/pdf",
    });
    expect(path).toBe("company/co-1/vendor/vnd-1/documents/doc-1.pdf");
  });

  it("uses the extension for the declared mime type, not a client-supplied filename", () => {
    const path = buildStoragePath({
      companyId: "co-1",
      vendorId: "vnd-1",
      documentId: "doc-1",
      mimeType: "image/png",
    });
    expect(path.endsWith(".png")).toBe(true);
  });

  it("throws rather than writing an unrestricted path for a disallowed mime type", () => {
    expect(() =>
      buildStoragePath({
        companyId: "co-1",
        vendorId: "vnd-1",
        documentId: "doc-1",
        mimeType: "application/octet-stream",
      }),
    ).toThrow();
  });
});

describe("expiry", () => {
  it("sets the expiry TTL_DAYS ahead", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const expires = newExpiryDate(from);
    const diffDays = (expires.getTime() - from.getTime()) / 86_400_000;
    expect(diffDays).toBe(UPLOAD_REQUEST_TTL_DAYS);
  });

  it("treats a past date as expired and a future date as not", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    expect(isExpired("2026-08-31T23:59:59Z", now)).toBe(true);
    expect(isExpired("2026-09-02T00:00:00Z", now)).toBe(false);
  });

  it("treats the exact expiry instant as expired, not as one more valid moment", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    expect(isExpired(now, now)).toBe(true);
  });
});

describe("status transitions", () => {
  it("only pending/email_sent/opened requests can be opened", () => {
    expect(canOpenRequest("pending")).toBe(true);
    expect(canOpenRequest("email_sent")).toBe(true);
    expect(canOpenRequest("opened")).toBe(true);
    for (const terminal of ["uploaded", "processing", "completed", "expired", "cancelled"]) {
      expect(canOpenRequest(terminal)).toBe(false);
    }
  });

  it("allows re-upload from needs_review, but never after completion or cancellation", () => {
    expect(canUploadToRequest("needs_review")).toBe(true);
    expect(canUploadToRequest("completed")).toBe(false);
    expect(canUploadToRequest("cancelled")).toBe(false);
    expect(canUploadToRequest("expired")).toBe(false);
  });

  it("can only cancel a request the vendor has not acted on at all yet", () => {
    expect(canCancelRequest("pending")).toBe(true);
    expect(canCancelRequest("email_sent")).toBe(true);
    expect(canCancelRequest("opened")).toBe(true);
    // Once anything has been uploaded, the ask has been fulfilled or is
    // being worked - not something left to call off.
    for (const acted of [
      "uploaded",
      "processing",
      "needs_review",
      "completed",
      "expired",
      "cancelled",
    ]) {
      expect(canCancelRequest(acted)).toBe(false);
    }
  });
});
