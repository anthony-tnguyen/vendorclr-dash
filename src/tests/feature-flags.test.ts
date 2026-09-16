import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the typed key union and the query/error-handling shape
 * of isCompanyFeatureEnabled(). RLS itself - who may actually read/write
 * which rows - is proven against real Postgres in
 * supabase/tests/feature-flags.test.ts, not here: PGlite tests can prove
 * RLS behaves; a mocked client here only proves this function builds the
 * right query and fails closed, which RLS coverage can't see either.
 */

const maybeSingle = vi.fn();
const chain = {
  from: vi.fn(() => chain),
  select: vi.fn(() => chain),
  eq: vi.fn(() => chain),
  maybeSingle,
};

vi.mock("@/lib/supabase/serverClient.server", () => ({
  getRequestScopedClient: vi.fn(async () => chain),
}));

const { FEATURE_FLAG_KEYS, isCompanyFeatureEnabled, isFeatureFlagKey } =
  await import("@/domain/featureFlags");

beforeEach(() => {
  maybeSingle.mockReset();
  chain.from.mockClear();
  chain.select.mockClear();
  chain.eq.mockClear();
});

describe("FEATURE_FLAG_KEYS", () => {
  it("is exactly the seven keys this phase of the plan defines", () => {
    expect(FEATURE_FLAG_KEYS).toEqual([
      "construction_core",
      "requirement_profiles",
      "team_invites",
      "submission_packages",
      "deficiency_cases",
      "exceptions",
      "reports_v2",
    ]);
  });
});

describe("isFeatureFlagKey", () => {
  it.each(FEATURE_FLAG_KEYS)("accepts %s", (key) => {
    expect(isFeatureFlagKey(key)).toBe(true);
  });

  it("rejects an unknown string", () => {
    expect(isFeatureFlagKey("not_a_real_flag")).toBe(false);
  });
});

describe("isCompanyFeatureEnabled", () => {
  it("queries company_feature_flags filtered by company_id and key", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { enabled: true }, error: null });

    await isCompanyFeatureEnabled("company-1", "construction_core");

    expect(chain.from).toHaveBeenCalledWith("company_feature_flags");
    expect(chain.select).toHaveBeenCalledWith("enabled");
    expect(chain.eq).toHaveBeenNthCalledWith(1, "company_id", "company-1");
    expect(chain.eq).toHaveBeenNthCalledWith(2, "key", "construction_core");
  });

  it("returns true when the stored row is enabled", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { enabled: true }, error: null });
    await expect(isCompanyFeatureEnabled("company-1", "construction_core")).resolves.toBe(true);
  });

  it("returns false when the stored row is disabled", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { enabled: false }, error: null });
    await expect(isCompanyFeatureEnabled("company-1", "construction_core")).resolves.toBe(false);
  });

  it("defaults to false when no row exists - flags default off", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(isCompanyFeatureEnabled("company-1", "team_invites")).resolves.toBe(false);
  });

  it("fails closed: throws rather than defaulting to enabled on a query error", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(isCompanyFeatureEnabled("company-1", "reports_v2")).rejects.toThrow(/boom/);
  });
});
