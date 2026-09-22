import { describe, expect, it } from "vitest";

import {
  packageDocumentStatus,
  toPortalDocuments,
  vendorRequestPurposeMessage,
} from "@/workflows/submissionPackages";

describe("packageDocumentStatus", () => {
  it("keeps an uploaded document pending until the asynchronous processor finishes", () => {
    expect(packageDocumentStatus({ packageStatus: "open", processingStatus: "uploaded" })).toBe(
      "uploaded",
    );
    expect(
      packageDocumentStatus({ packageStatus: "finalized", processingStatus: "uploaded" }),
    ).toBe("processing");
  });

  it("does not report compliance for an evaluated document", () => {
    expect(
      packageDocumentStatus({ packageStatus: "finalized", processingStatus: "processed" }),
    ).toBe("complete");
    expect(
      packageDocumentStatus({ packageStatus: "finalized", processingStatus: "needs_review" }),
    ).toBe("needs replacement");
  });
});

describe("toPortalDocuments", () => {
  // The shape PostgREST actually returns for package_documents ->
  // vendor_documents: a many-to-one embed is a single object, not an array.
  it("reads file name and processing status from an object-shaped embed", () => {
    const [doc] = toPortalDocuments(
      [
        {
          document_id: "doc-1",
          document_kind: "certificate_of_insurance",
          vendor_documents: { file_name: "acme-coi.pdf", processing_status: "needs_review" },
        },
      ],
      "finalized",
    );
    expect(doc).toEqual({
      id: "doc-1",
      fileName: "acme-coi.pdf",
      documentKind: "certificate_of_insurance",
      processingStatus: "needs_review",
      status: "needs replacement",
    });
  });

  it("still accepts an array-shaped embed and falls back when the document is missing", () => {
    const [fromArray, missing] = toPortalDocuments(
      [
        {
          document_id: "doc-2",
          document_kind: "other",
          vendor_documents: [{ file_name: "endorsement.pdf", processing_status: "processed" }],
        },
        { document_id: "doc-3", document_kind: "other", vendor_documents: null },
      ],
      "finalized",
    );
    expect(fromArray).toMatchObject({ fileName: "endorsement.pdf", status: "complete" });
    expect(missing).toMatchObject({ fileName: "Uploaded document", status: "processing" });
  });
});

describe("vendorRequestPurposeMessage", () => {
  it("never shows the raw purpose code to the vendor", () => {
    for (const purpose of ["initial", "renewal", "correction", "", null, undefined]) {
      const message = vendorRequestPurposeMessage(purpose);
      expect(message).toMatch(/^[A-Z].+\.$/);
      expect(message).not.toBe(purpose);
    }
    expect(vendorRequestPurposeMessage("correction")).toMatch(/corrected/);
  });
});
