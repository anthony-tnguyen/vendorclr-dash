import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * buildLiveHealthPayload()/buildReadyHealthPayload() are exported directly
 * from the route files (api.health.live.ts/api.health.ready.ts) specifically
 * so they can be unit-tested without going through the router's "throw a
 * Response from a loader" mechanism (see that file's own docblock for why
 * this TanStack Start version uses that mechanism at all) or a real HTTP
 * request - this proves the payload shape and the pass/fail logic
 * independent of the router plumbing around it.
 */

const selectMock = vi.fn();
const fromMock = vi.fn(() => ({ select: selectMock }));

vi.mock("@/lib/supabase/serverClient.server", () => ({
  getServiceRoleClient: vi.fn(() => ({ from: fromMock })),
}));

const { buildLiveHealthPayload } = await import("@/routes/api.health.live");
const { buildReadyHealthPayload } = await import("@/routes/api.health.ready");

beforeEach(() => {
  selectMock.mockReset();
  fromMock.mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildLiveHealthPayload()", () => {
  it("returns ok with no I/O and never touches Supabase", () => {
    const payload = buildLiveHealthPayload();
    expect(payload.status).toBe("ok");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("includes an ISO timestamp, a release SHA and an environment", () => {
    const payload = buildLiveHealthPayload();
    expect(() => new Date(payload.time).toISOString()).not.toThrow();
    expect(typeof payload.releaseSha).toBe("string");
    expect(typeof payload.environment).toBe("string");
  });

  it("falls back to releaseSha 'unknown' when VITE_RELEASE_SHA is unset", () => {
    expect(buildLiveHealthPayload().releaseSha).toBe("unknown");
  });
});

describe("buildReadyHealthPayload()", () => {
  it("reports supabase not_configured, with a 200, when service-role env vars are absent", async () => {
    vi.stubEnv("VENDORCLEAR_SUPABASE_URL", "");
    vi.stubEnv("VENDORCLEAR_SERVICE_ROLE_KEY", "");

    const { payload, httpStatus } = await buildReadyHealthPayload();

    expect(payload.dependencies.supabase).toBe("not_configured");
    expect(payload.status).toBe("ok");
    expect(httpStatus).toBe(200);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("reports supabase ok, with a 200, when the cheap query succeeds", async () => {
    vi.stubEnv("VENDORCLEAR_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VENDORCLEAR_SERVICE_ROLE_KEY", "service-role-secret");
    selectMock.mockResolvedValueOnce({ error: null });

    const { payload, httpStatus } = await buildReadyHealthPayload();

    expect(payload.dependencies.supabase).toBe("ok");
    expect(payload.status).toBe("ok");
    expect(httpStatus).toBe(200);
  });

  it("reports supabase unreachable, with a 503, when the cheap query errors", async () => {
    vi.stubEnv("VENDORCLEAR_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VENDORCLEAR_SERVICE_ROLE_KEY", "service-role-secret");
    selectMock.mockResolvedValueOnce({ error: { message: "connection refused" } });

    const { payload, httpStatus } = await buildReadyHealthPayload();

    expect(payload.dependencies.supabase).toBe("unreachable");
    expect(payload.status).toBe("degraded");
    expect(httpStatus).toBe(503);
  });

  it("reports supabase unreachable, with a 503, when the client throws", async () => {
    vi.stubEnv("VENDORCLEAR_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VENDORCLEAR_SERVICE_ROLE_KEY", "service-role-secret");
    selectMock.mockRejectedValueOnce(new Error("network down"));

    const { payload, httpStatus } = await buildReadyHealthPayload();

    expect(payload.dependencies.supabase).toBe("unreachable");
    expect(httpStatus).toBe(503);
  });

  it("reports configuration presence by name only - booleans, never a secret value", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_super_secret_value");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("VIRUSTOTAL_API_KEY", "vt_secret");

    const { payload } = await buildReadyHealthPayload();

    expect(payload.configuration.resendApiKey).toBe(true);
    expect(payload.configuration.anthropicApiKey).toBe(false);
    expect(payload.configuration.virustotalApiKey).toBe(true);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("re_super_secret_value");
    expect(serialized).not.toContain("vt_secret");
  });
});
