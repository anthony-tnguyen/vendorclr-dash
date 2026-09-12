import { describe, expect, it } from "vitest";
import * as documentReview from "@/workflows/documentReview";

describe("review policy selection", () => {
  it("only applies classified policy lines explicitly selected by the reviewer", () => {
    const select = (documentReview as Record<string, unknown>)["selectClassifiedPolicies"];

    expect(select).toBeTypeOf("function");
    if (typeof select !== "function") return;

    const policies = [
      { type: "general_liability", carrier: "Northstar" },
      { type: null, carrier: "Unreadable" },
      { type: "workers_compensation", carrier: "Forge" },
    ];

    expect(select(policies, ["workers_compensation"])).toEqual([
      { type: "workers_compensation", carrier: "Forge" },
    ]);
  });
});
