import { afterEach, describe, expect, it, vi } from "vitest";

import { getRepository, isBackendConfigured, resetRepository } from "@/data/repository";
import { hasBackendEnv, readSupabaseEnv } from "@/lib/supabase/env";

afterEach(() => {
  vi.unstubAllEnvs();
  resetRepository();
});

describe("backend feature flag", () => {
  it("reports no backend when the env vars are absent", () => {
    expect(readSupabaseEnv()).toBeNull();
    expect(hasBackendEnv()).toBe(false);
    expect(isBackendConfigured()).toBe(false);
  });

  it("requires both the url and the anon key", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    expect(hasBackendEnv()).toBe(false);

    vi.unstubAllEnvs();
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    expect(hasBackendEnv()).toBe(false);
  });

  it("treats whitespace-only values as unset", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "   ");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "   ");

    expect(hasBackendEnv()).toBe(false);
  });

  it("activates once both values are present", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");

    expect(readSupabaseEnv()).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
    });
    expect(hasBackendEnv()).toBe(true);
  });
});

describe("getRepository", () => {
  it("falls back to the in-memory demo repository with no backend configured", async () => {
    const repo = getRepository();
    const vendors = await repo.listVendors();

    // The demo seed data, proving no network call was attempted.
    expect(vendors.map((v) => v.name)).toContain("Corbett Structural Steel");
  });

  it("returns a stable instance so in-memory demo writes persist across calls", async () => {
    const repo = getRepository();
    expect(getRepository()).toBe(repo);

    await repo.createVendor({
      name: "Test Vendor",
      trade: "Roofing",
      project: "Harbor Point Tower B",
      contactName: "Sam Vale",
      contactEmail: "sam@example.test",
      contractValue: 1000,
    });

    const names = (await getRepository().listVendors()).map((v) => v.name);
    expect(names).toContain("Test Vendor");
  });

  it("saves a vendor whose trade is 'Other' as the literal string", async () => {
    const created = await getRepository().createVendor({
      name: "Miscellany Subs",
      trade: "Other",
      project: "Harbor Point Tower B",
      contactName: "Pat Lee",
      contactEmail: "pat@example.test",
      contractValue: 5000,
    });

    expect(created.trade).toBe("Other");
    const roster = await getRepository().listVendors();
    expect(roster.find((v) => v.name === "Miscellany Subs")?.trade).toBe("Other");
  });

  it("starts a newly created vendor with every requirement missing", async () => {
    const created = await getRepository().createVendor({
      name: "Fresh Sub",
      trade: "Glazing",
      project: "Cedar Ridge Medical",
      contactName: "Alex Reyes",
      contactEmail: "alex@example.test",
      contractValue: 250_000,
    });

    expect(created.compliance).toHaveLength(5);
    expect(created.compliance.every((c) => c.status === "missing")).toBe(true);
  });
});
