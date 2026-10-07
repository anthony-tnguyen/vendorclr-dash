import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  throw new Error("The server-only Anthropic SDK was loaded by a browser-reachable module.");
});

describe("browser-reachable workflow import boundaries", () => {
  it("loads COI workflows without loading the server-only extraction provider", async () => {
    await expect(
      Promise.all([import("@/workflows/coiIntake"), import("@/workflows/vendorUploadRequests")]),
    ).resolves.toHaveLength(2);
  });
});
