import { describe, expect, it } from "vitest";

import { packageDocumentStatus } from "@/workflows/submissionPackages";

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
