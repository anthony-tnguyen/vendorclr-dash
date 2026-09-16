import { describe, expect, it } from "vitest";

import {
  detectSignature,
  FileValidationError,
  pdfAppearsEncrypted,
  validateUploadedFile,
} from "@/workflows/fileValidation.server";

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // "%PDF-1.4"
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesOf(...parts: Array<number[] | string>): ArrayBuffer {
  const chunks: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") chunks.push(...new TextEncoder().encode(part));
    else chunks.push(...part);
  }
  return new Uint8Array(chunks).buffer;
}

function fileOf(bytes: ArrayBuffer, name: string, type: string): File {
  return new File([bytes], name, { type });
}

describe("detectSignature", () => {
  it("recognizes a real PDF header", () => {
    expect(detectSignature(bytesOf(PDF_HEADER, " rest of file"))).toBe("application/pdf");
  });

  it("recognizes a real JPEG header", () => {
    expect(detectSignature(bytesOf(JPEG_HEADER))).toBe("image/jpeg");
  });

  it("recognizes a real PNG header", () => {
    expect(detectSignature(bytesOf(PNG_HEADER))).toBe("image/png");
  });

  it("returns null for bytes matching no known signature", () => {
    expect(detectSignature(bytesOf("just some plain text, not a real file"))).toBeNull();
  });

  it("returns null for a buffer shorter than any signature", () => {
    expect(detectSignature(new Uint8Array([0x25, 0x50]).buffer)).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(detectSignature(new ArrayBuffer(0))).toBeNull();
  });
});

describe("pdfAppearsEncrypted", () => {
  it("is false for a plain, unencrypted PDF body", () => {
    const bytes = bytesOf(
      PDF_HEADER,
      "\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Size 2 >>",
    );
    expect(pdfAppearsEncrypted(bytes)).toBe(false);
  });

  it("is true when the trailer carries an /Encrypt entry", () => {
    const bytes = bytesOf(
      PDF_HEADER,
      "\ntrailer\n<< /Root 1 0 R /Size 2 /Encrypt 3 0 R /ID [<abc><abc>] >>",
    );
    expect(pdfAppearsEncrypted(bytes)).toBe(true);
  });

  it("is false for an empty buffer", () => {
    expect(pdfAppearsEncrypted(new ArrayBuffer(0))).toBe(false);
  });
});

describe("validateUploadedFile", () => {
  it("accepts a genuine PDF whose declared type matches its content", async () => {
    const bytes = bytesOf(PDF_HEADER, " body");
    const result = await validateUploadedFile(fileOf(bytes, "cert.pdf", "application/pdf"));
    expect(result.detectedMime).toBe("application/pdf");
    expect(result.encryptedPdf).toBe(false);
    expect(result.bytes.byteLength).toBe(bytes.byteLength);
  });

  it("accepts a genuine JPEG", async () => {
    const result = await validateUploadedFile(
      fileOf(bytesOf(JPEG_HEADER), "cert.jpg", "image/jpeg"),
    );
    expect(result.detectedMime).toBe("image/jpeg");
    expect(result.encryptedPdf).toBe(false);
  });

  it("accepts a genuine PNG", async () => {
    const result = await validateUploadedFile(fileOf(bytesOf(PNG_HEADER), "cert.png", "image/png"));
    expect(result.detectedMime).toBe("image/png");
  });

  it("trusts the detected signature, not an empty/missing declared type", async () => {
    const result = await validateUploadedFile(fileOf(bytesOf(PDF_HEADER), "cert", ""));
    expect(result.detectedMime).toBe("application/pdf");
  });

  it("rejects an empty file with code empty_file", async () => {
    await expect(
      validateUploadedFile(fileOf(new ArrayBuffer(0), "empty.pdf", "application/pdf")),
    ).rejects.toMatchObject({ code: "empty_file" });
  });

  it("rejects content matching no known signature with code unsupported_type", async () => {
    await expect(
      validateUploadedFile(fileOf(bytesOf("not a real document"), "fake.pdf", "application/pdf")),
    ).rejects.toMatchObject({ code: "unsupported_type" });
  });

  it("rejects a forged declared MIME type that disagrees with the real content, with code mime_mismatch", async () => {
    // Real bytes are a JPEG; the browser/attacker claims it's a PDF.
    await expect(
      validateUploadedFile(fileOf(bytesOf(JPEG_HEADER), "cert.pdf", "application/pdf")),
    ).rejects.toMatchObject({ code: "mime_mismatch" });
  });

  it("every thrown rejection is a FileValidationError instance", async () => {
    await expect(
      validateUploadedFile(fileOf(new ArrayBuffer(0), "empty.pdf", "application/pdf")),
    ).rejects.toBeInstanceOf(FileValidationError);
  });

  it("returns encryptedPdf true, without throwing, for a PDF with an /Encrypt trailer", async () => {
    const bytes = bytesOf(PDF_HEADER, "\ntrailer\n<< /Encrypt 3 0 R >>");
    const result = await validateUploadedFile(fileOf(bytes, "cert.pdf", "application/pdf"));
    expect(result.detectedMime).toBe("application/pdf");
    expect(result.encryptedPdf).toBe(true);
  });

  it("never flags encryptedPdf for a JPEG or PNG, even if it happens to contain the bytes /Encrypt", async () => {
    const bytes = bytesOf(JPEG_HEADER, "/Encrypt just coincidental bytes");
    const result = await validateUploadedFile(fileOf(bytes, "cert.jpg", "image/jpeg"));
    expect(result.detectedMime).toBe("image/jpeg");
    expect(result.encryptedPdf).toBe(false);
  });
});
