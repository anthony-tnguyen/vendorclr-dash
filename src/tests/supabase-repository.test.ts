import { describe, expect, it } from "vitest";

import {
  primaryPolicy,
  toComplianceItems,
  toCoverageLimits,
  toVendor,
  type VendorWithChildren,
} from "@/data/supabaseRepository";
import type {
  ComplianceRequirementRow,
  VendorComplianceItemRow,
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
    certificate_holder_name: null,
    certificate_holder_address: null,
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

function requirement(overrides: Partial<ComplianceRequirementRow> = {}): ComplianceRequirementRow {
  return {
    id: "req-1",
    company_id: "co-1",
    label: "General liability / occurrence",
    policy_type: "general_liability",
    limit_field: "each_occurrence_limit",
    required_amount: 2_000_000,
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
  it("orders by sort_order and reads carried live from the vendor's active policy", () => {
    const limits = toCoverageLimits(
      [
        requirement({ id: "b", label: "Excess liability", sort_order: 1, policy_type: "umbrella" }),
        requirement({ id: "a", label: "General liability / occurrence", sort_order: 0 }),
      ],
      [policy({ policy_type: "general_liability", each_occurrence_limit: 2_000_000 })],
    );

    expect(limits.map((l) => l.label)).toEqual([
      "General liability / occurrence",
      "Excess liability",
    ]);
    // No umbrella policy on file at all - carried falls back to 0, not omitted.
    expect(limits[1]).toMatchObject({ required: 2_000_000, carried: 0 });
    expect(limits[0]).toMatchObject({ required: 2_000_000, carried: 2_000_000 });
  });

  it("reads the requirement's own limit_field, not a fixed one", () => {
    const limits = toCoverageLimits(
      [requirement({ limit_field: "general_aggregate_limit", required_amount: 4_000_000 })],
      [policy({ each_occurrence_limit: 2_000_000, general_aggregate_limit: 4_000_000 })],
    );

    expect(limits[0]).toMatchObject({ required: 4_000_000, carried: 4_000_000 });
  });

  it("ignores a superseded/expired policy of the right type - carried falls back to 0", () => {
    const limits = toCoverageLimits(
      [requirement()],
      [policy({ status: "superseded", each_occurrence_limit: 2_000_000 })],
    );

    expect(limits[0]?.carried).toBe(0);
  });
});

describe("toVendor", () => {
  it("flattens the primary policy onto the legacy Vendor fields", () => {
    const vendor = toVendor(
      vendorRow({
        vendor_policies: [policy({ policy_number: "GL-8841-2266", expiration_date: "2026-11-30" })],
      }),
      [],
    );

    expect(vendor.policyNumber).toBe("GL-8841-2266");
    expect(vendor.expiresOn).toBe("2026-11-30");
  });

  it("surfaces the primary policy's certificate holder for a client to check against their own name", () => {
    const vendor = toVendor(
      vendorRow({
        vendor_policies: [
          policy({
            certificate_holder_name: "Halstead Builders",
            certificate_holder_address: "500 Harbor Point Way, Boston, MA 02110",
          }),
        ],
      }),
      [],
    );

    expect(vendor.certificateHolderName).toBe("Halstead Builders");
    expect(vendor.certificateHolderAddress).toBe("500 Harbor Point Way, Boston, MA 02110");
  });

  it("uses the same placeholders as the demo repository when no policy exists", () => {
    const vendor = toVendor(vendorRow(), []);

    expect(vendor.policyNumber).toBe("PENDING");
    expect(vendor.expiresOn).toBe("—");
    expect(vendor.certificateHolderName).toBe("Not on file");
    expect(vendor.certificateHolderAddress).toBe("Not on file");
  });

  it("falls back to 'Not on file' when a policy exists but extraction never read a certificate holder", () => {
    const vendor = toVendor(
      vendorRow({
        vendor_policies: [
          policy({ certificate_holder_name: null, certificate_holder_address: null }),
        ],
      }),
      [],
    );

    expect(vendor.certificateHolderName).toBe("Not on file");
    expect(vendor.certificateHolderAddress).toBe("Not on file");
  });

  it("reports a brand new vendor as entirely non-compliant", () => {
    // The rule the whole product depends on: a vendor record existing, or a
    // document existing, is never by itself evidence of compliance.
    const vendor = toVendor(vendorRow(), []);

    expect(vendor.compliance).toHaveLength(5);
    expect(vendor.compliance.every((c) => c.status === "missing")).toBe(true);
  });

  it("maps identity and contract fields onto the UI contract", () => {
    const vendor = toVendor(
      vendorRow({
        vendor_policies: [
          policy({ policy_type: "general_liability", each_occurrence_limit: 2_000_000 }),
        ],
      }),
      [requirement()],
    );

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
