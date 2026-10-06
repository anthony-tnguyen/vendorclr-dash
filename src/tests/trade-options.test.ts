import { describe, expect, it } from "vitest";

import { VENDOR_TRADES } from "@/workflows/coiIntakeMapping";
import { TRADE_VALUES } from "@/workflows/vendorImports";

describe("shared trade options", () => {
  it("offers Other as the last trade", () => {
    expect(VENDOR_TRADES.at(-1)).toBe("Other");
  });

  it("matches the CSV import vocabulary exactly", () => {
    expect([...VENDOR_TRADES]).toEqual([...TRADE_VALUES]);
  });
});
