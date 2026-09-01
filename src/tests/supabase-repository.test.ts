import { describe, expect, it } from "vitest";

import {
  primaryPolicy,
  toComplianceItems,
  toCoverageLimits,
  toVendor,
  type VendorWithChildren,
} from "@/data/supabaseRepository";
import type {
  VendorComplianceItemRow,
  VendorCoverageLimitRow,
  VendorPolicyRow,
} from "@/data/db-types";

const TIMESTAMPS = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };

function policy(overrides: Partial<VendorPolicyRow> = {}): VendorPolicyRow {
  return {
    id: "pol-1",
    company_id: "co-1",
    vendor_id: "vnd-1",
    policy_type: "general_liability",
    carrier_name: "Travelers",
    policy_number: "GL-1",
    effective_date: "2025-10-01",
    expiration_date: "2026-10-01",
    each_occurrence_limit: null,
    general_aggregate_limit: null,
    additional_insured: null,
    waiver_of_subrogation: null,
    primary_noncontributory: null,
    status: "active",
    verification_status: "unverified",
    ...TIMESTAMPS,
    ...overrides,
  };
}

function item(overrides: Partial<VendorComplianceItemRow> = {}): VendorComplianceItemRow {
  return {
    id: "ci-1",
    company_id: "co-1",
    vendor_id: "vnd-1",
    requirement_key: "coi",
    status: "compliant",
    effective_date: "2026-10-01",
    note: null,
    ...TIMESTAMPS,
    ...overrides,
  };
}

function limit(overrides: Partial<VendorCoverageLimitRow> = {}): VendorCoverageLimitRow {
  return {
    id: "cl-1",
    company_id: "co-1",
    vendor_id: "vnd-1",
    label: "General liability / occurrence",
    required_amount: 2_000_000,
    carried_amount: 2_000_000,
    sort_order: 0,
    ...TIMESTAMPS,
    ...overrides,
  };
}

function vendorRow(overrides: Partial<VendorWithChildren> = {}): VendorWithChildren {
  return {
    id: "vnd-1",
    company_id: "co-1",
    name: "Corbett Structural Steel",
    trade: "Structural Steel",
    project: "Harbor Point Tower B",
    contract_value: 4_820_000,
    contact_name: "Dana Corbett",
    contact_email: "dana@corbettsteel.example",
    risk_tier: "high",
    archived_at: null,
    ...TIMESTAMPS,
    vendor_policies: [],
    vendor_compliance_items: [],
    vendor_coverage_limits: [],
    ...overrides,
  };
}

describe("primaryPolicy", () => {
  it("prefers general liability over other coverage types", () => {
    const chosen = primaryPolicy([
      policy({ id: "auto", policy_type: "commercial_auto", policy_number: "AU-9" }),
      policy({ id: "gl", policy_type: "general_liability", policy_number: "GL-9" }),
    ]);

    expect(chosen?.policy_number).toBe("GL-9");
  });

  it("picks the soonest-expiring GL policy when several are active", () => {
    const chosen = primaryPolicy([
      policy({ id: "later", policy_number: "GL-LATE", expiration_date: "2027-01-01" }),
      policy({ id: "sooner", policy_number: "GL-SOON", expiration_date: "2026-03-01" }),
    ]);

    expect(chosen?.policy_number).toBe("GL-SOON");
  });

  it("falls back to the soonest-expiring policy when there is no GL policy", () => {
    const chosen = primaryPolicy([
      policy({ policy_type: "umbrella", policy_number: "UMB-1", expiration_date: "2027-05-01" }),
      policy({
        policy_type: "commercial_auto",
        policy_number: "AU-1",
        expiration_date: "2026-06-01",
      }),
    ]);

    expect(chosen?.policy_number).toBe("AU-1");
  });

  it("ignores superseded and cancelled policies", () => {
    const chosen = primaryPolicy([
      policy({ policy_number: "OLD", status: "superseded", expiration_date: "2025-01-01" }),
      policy({ policy_number: "DEAD", status: "cancelled", expiration_date: "2025-02-01" }),
      policy({ policy_number: "CURRENT", status: "active", expiration_date: "2027-01-01" }),
    ]);

    expect(chosen?.policy_number).toBe("CURRENT");
  });

  it("returns null when nothing is active", () => {
    expect(primaryPolicy([])).toBeNull();
    expect(primaryPolicy([policy({ status: "expired" })])).toBeNull();
  });
});

describe("toComplianceItems", () => {
  it("always emits all five rail segments in order", () => {
    const items = toComplianceItems([item({ requirement_key: "renewal", status: "expiring" })]);

    expect(items.map((i) => i.key)).toEqual([
      "coi",
      "additionalInsured",
      "waiverOfSubrogation",
      "lienWaiver",
      "renewal",
    ]);
  });

  it("treats a requirement with no row as missing rather than dropping it", () => {
    const items = toComplianceItems([]);

    expect(items).toHaveLength(5);
    expect(items.every((i) => i.status === "missing")).toBe(true);
    expect(items.every((i) => i.effectiveDate === null)).toBe(true);
  });
});

describe("toCoverageLimits", () => {
  it("orders by sort_order and preserves required vs carried", () => {
    const limits = toCoverageLimits([
      limit({ id: "b", label: "Excess liability", sort_order: 1, carried_amount: 0 }),
      limit({ id: "a", label: "General liability / occurrence", sort_order: 0 }),
    ]);

    expect(limits.map((l) => l.label)).toEqual([
      "General liability / occurrence",
      "Excess liability",
    ]);
    expect(limits[1]).toMatchObject({ required: 2_000_000, carried: 0 });
  });
});

describe("toVendor", () => {
  it("flattens the primary policy onto the legacy Vendor fields", () => {
    const vendor = toVendor(
      vendorRow({
        vendor_policies: [policy({ policy_number: "GL-8841-2266", expiration_date: "2026-11-30" })],
      }),
    );

    expect(vendor.policyNumber).toBe("GL-8841-2266");
    expect(vendor.expiresOn).toBe("2026-11-30");
  });

  it("uses the same placeholders as the demo repository when no policy exists", () => {
    const vendor = toVendor(vendorRow());

    expect(vendor.policyNumber).toBe("PENDING");
    expect(vendor.expiresOn).toBe("—");
  });

  it("reports a brand new vendor as entirely non-compliant", () => {
    // The rule the whole product depends on: a vendor record existing, or a
    // document existing, is never by itself evidence of compliance.
    const vendor = toVendor(vendorRow());

    expect(vendor.compliance).toHaveLength(5);
    expect(vendor.compliance.every((c) => c.status === "missing")).toBe(true);
  });

  it("maps identity and contract fields onto the UI contract", () => {
    const vendor = toVendor(vendorRow({ vendor_coverage_limits: [limit()] }));

    expect(vendor).toMatchObject({
      id: "vnd-1",
      name: "Corbett Structural Steel",
      trade: "Structural Steel",
      project: "Harbor Point Tower B",
      contractValue: 4_820_000,
      contactEmail: "dana@corbettsteel.example",
      riskTier: "high",
    });
    expect(vendor.limits).toEqual([
      { label: "General liability / occurrence", required: 2_000_000, carried: 2_000_000 },
    ]);
  });
});
