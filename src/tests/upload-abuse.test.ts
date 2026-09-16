// @vitest-environment node
//
// Node, not jsdom: this file drives a real TanStack Start request context
// (requestHandler()/getRequest() from "@tanstack/react-start/server", both
// AsyncLocalStorage/h3-v2-backed) to empirically verify IP extraction, and
// exercises Web Crypto (HMAC/SHA-256) directly - neither needs, or benefits
// from, a DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcCounters = new Map<string, number>();
const rpcMock = vi.fn((_fn: string, args: { p_bucket_key: string; p_window_start: string }) => {
  const key = `${args.p_bucket_key}::${args.p_window_start}`;
  const next = (rpcCounters.get(key) ?? 0) + 1;
  rpcCounters.set(key, next);
  return Promise.resolve({ data: next, error: null });
});

vi.mock("@/lib/supabase/serverClient.server", () => ({
  getServiceRoleClient: () => ({ rpc: rpcMock }),
}));

const {
  assertUploadAllowed,
  CaptchaRequiredError,
  computeWindowStart,
  extractClientIp,
  getUploadAbuseIpHmacSecret,
  hmacIpAddress,
  INVALID_TOKEN_IP_LIMIT,
  RESOLVE_IP_LIMIT,
  UPLOAD_COMPANY_DAILY_LIMIT,
  UPLOAD_IP_LIMIT,
  UPLOAD_TOKEN_LIMIT,
  UploadThrottledError,
  verifyTurnstileToken,
} = await import("@/workflows/uploadAbuse.server");

const ORIGINAL_SECRET = process.env["UPLOAD_ABUSE_IP_HMAC_SECRET"];
const ORIGINAL_TURNSTILE = process.env["TURNSTILE_SECRET_KEY"];
let ipCounter = 0;

/** A fresh IP per call keeps tests isolated from one another without needing to fake timers or reset rpcCounters by hand. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

beforeEach(() => {
  process.env["UPLOAD_ABUSE_IP_HMAC_SECRET"] = "test-secret-value";
  delete process.env["TURNSTILE_SECRET_KEY"];
  rpcMock.mockClear();
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["UPLOAD_ABUSE_IP_HMAC_SECRET"];
  else process.env["UPLOAD_ABUSE_IP_HMAC_SECRET"] = ORIGINAL_SECRET;
  if (ORIGINAL_TURNSTILE === undefined) delete process.env["TURNSTILE_SECRET_KEY"];
  else process.env["TURNSTILE_SECRET_KEY"] = ORIGINAL_TURNSTILE;
  vi.unstubAllGlobals();
});

describe("extractClientIp", () => {
  it("prefers cf-connecting-ip when present", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.5",
      "x-forwarded-for": "10.0.0.1",
    });
    expect(extractClientIp(headers)).toBe("203.0.113.5");
  });

  it("falls back to the first entry of x-forwarded-for when cf-connecting-ip is absent", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.9, 10.0.0.1, 10.0.0.2" });
    expect(extractClientIp(headers)).toBe("198.51.100.9");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    expect(extractClientIp(new Headers())).toBe("unknown");
  });

  it("ignores a blank cf-connecting-ip and still checks x-forwarded-for", () => {
    const headers = new Headers({ "cf-connecting-ip": "   ", "x-forwarded-for": "198.51.100.9" });
    expect(extractClientIp(headers)).toBe("198.51.100.9");
  });
});

describe("extractClientIp against a real TanStack Start request context", () => {
  it("reads cf-connecting-ip from an actual incoming Request via getRequest()", async () => {
    const { getRequest, requestHandler } = await import("@tanstack/react-start/server");
    const handler = requestHandler(async () => {
      return new Response(extractClientIp(getRequest().headers));
    });
    const request = new Request("http://localhost/vendor-upload/some-token", {
      headers: { "cf-connecting-ip": "203.0.113.77", "x-forwarded-for": "198.51.100.1" },
    });

    const response = await handler(request, {});

    expect(await response.text()).toBe("203.0.113.77");
  });

  it("falls back to x-forwarded-for's first entry when cf-connecting-ip is absent, in a real request context", async () => {
    const { getRequest, requestHandler } = await import("@tanstack/react-start/server");
    const handler = requestHandler(async () => {
      return new Response(extractClientIp(getRequest().headers));
    });
    const request = new Request("http://localhost/vendor-upload/some-token", {
      headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
    });

    const response = await handler(request, {});

    expect(await response.text()).toBe("198.51.100.1");
  });
});

describe("computeWindowStart", () => {
  it("truncates to a multiple of windowMs since epoch", () => {
    const windowMs = 10 * 60_000;
    expect(computeWindowStart(0, windowMs)).toBe(0);
    expect(computeWindowStart(windowMs - 1, windowMs)).toBe(0);
    expect(computeWindowStart(windowMs, windowMs)).toBe(windowMs);
    expect(computeWindowStart(windowMs * 3 + 1234, windowMs)).toBe(windowMs * 3);
  });
});

describe("getUploadAbuseIpHmacSecret / hmacIpAddress", () => {
  it("fails closed - throws rather than silently skipping rate limiting - when unset", async () => {
    delete process.env["UPLOAD_ABUSE_IP_HMAC_SECRET"];
    expect(() => getUploadAbuseIpHmacSecret()).toThrow(/UPLOAD_ABUSE_IP_HMAC_SECRET/);
    await expect(hmacIpAddress("203.0.113.5")).rejects.toThrow(/UPLOAD_ABUSE_IP_HMAC_SECRET/);
  });

  it("is deterministic for the same IP and secret", async () => {
    const a = await hmacIpAddress("203.0.113.5");
    const b = await hmacIpAddress("203.0.113.5");
    expect(a).toBe(b);
  });

  it("differs for different IPs", async () => {
    const a = await hmacIpAddress("203.0.113.5");
    const b = await hmacIpAddress("203.0.113.6");
    expect(a).not.toBe(b);
  });

  it("never contains the raw IP as a substring - it's a digest, not an encoding", async () => {
    const digest = await hmacIpAddress("203.0.113.5");
    expect(digest).not.toContain("203.0.113.5");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyTurnstileToken", () => {
  it("returns false without calling out when TURNSTILE_SECRET_KEY is unset", async () => {
    delete process.env["TURNSTILE_SECRET_KEY"];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyTurnstileToken("some-token")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns true when Cloudflare reports success", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );

    expect(await verifyTurnstileToken("good-token")).toBe(true);
  });

  it("returns false when Cloudflare reports failure", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
    );

    expect(await verifyTurnstileToken("bad-token")).toBe(false);
  });

  it("returns false, without throwing, on a network error", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    expect(await verifyTurnstileToken("token")).toBe(false);
  });
});

describe("assertUploadAllowed - per-operation rule selection", () => {
  it("allows a resolve well under the IP limit", async () => {
    await expect(
      assertUploadAllowed({ operation: "resolve", ipAddress: freshIp() }),
    ).resolves.toBeUndefined();
  });

  it("throttles the (RESOLVE_IP_LIMIT + 1)th resolve from the same IP within the window", async () => {
    const ipAddress = freshIp();
    for (let i = 0; i < RESOLVE_IP_LIMIT; i++) {
      await assertUploadAllowed({ operation: "resolve", ipAddress });
    }
    await expect(assertUploadAllowed({ operation: "resolve", ipAddress })).rejects.toBeInstanceOf(
      UploadThrottledError,
    );
  });

  it("throttles the (INVALID_TOKEN_IP_LIMIT + 1)th invalid-token attempt from the same IP", async () => {
    const ipAddress = freshIp();
    for (let i = 0; i < INVALID_TOKEN_IP_LIMIT; i++) {
      await assertUploadAllowed({ operation: "invalid_token", ipAddress });
    }
    await expect(
      assertUploadAllowed({ operation: "invalid_token", ipAddress }),
    ).rejects.toBeInstanceOf(UploadThrottledError);
  });

  it("does not let a resolve's attempts count against the invalid_token bucket, or vice versa", async () => {
    const ipAddress = freshIp();
    for (let i = 0; i < RESOLVE_IP_LIMIT; i++) {
      await assertUploadAllowed({ operation: "resolve", ipAddress });
    }
    // Same IP, different bucket - still allowed.
    await expect(
      assertUploadAllowed({ operation: "invalid_token", ipAddress }),
    ).resolves.toBeUndefined();
  });

  it("throttles the (UPLOAD_IP_LIMIT + 1)th upload from the same IP, with no tokenHash/companyId given", async () => {
    const ipAddress = freshIp();
    for (let i = 0; i < UPLOAD_IP_LIMIT; i++) {
      await assertUploadAllowed({ operation: "upload", ipAddress });
    }
    await expect(assertUploadAllowed({ operation: "upload", ipAddress })).rejects.toBeInstanceOf(
      UploadThrottledError,
    );
  });

  it("throttles the (UPLOAD_TOKEN_LIMIT + 1)th upload against the same token, across different IPs", async () => {
    const tokenHash = "a".repeat(64);
    for (let i = 0; i < UPLOAD_TOKEN_LIMIT; i++) {
      await assertUploadAllowed({ operation: "upload", ipAddress: freshIp(), tokenHash });
    }
    await expect(
      assertUploadAllowed({ operation: "upload", ipAddress: freshIp(), tokenHash }),
    ).rejects.toBeInstanceOf(UploadThrottledError);
  });

  it("throttles the (UPLOAD_COMPANY_DAILY_LIMIT + 1)th upload against the same company, across different IPs/tokens", async () => {
    const companyId = "11111111-1111-1111-1111-111111111111";
    for (let i = 0; i < UPLOAD_COMPANY_DAILY_LIMIT; i++) {
      await assertUploadAllowed({
        operation: "upload",
        ipAddress: freshIp(),
        tokenHash: `token-${i}`,
        companyId,
      });
    }
    await expect(
      assertUploadAllowed({
        operation: "upload",
        ipAddress: freshIp(),
        tokenHash: "one-more-token",
        companyId,
      }),
    ).rejects.toBeInstanceOf(UploadThrottledError);
  }, 20_000);
});

describe("assertUploadAllowed - captcha gate", () => {
  it("never throws CaptchaRequiredError when Turnstile is unconfigured, no matter how close to the limit", async () => {
    delete process.env["TURNSTILE_SECRET_KEY"];
    const ipAddress = freshIp();
    for (let i = 0; i < RESOLVE_IP_LIMIT; i++) {
      await expect(
        assertUploadAllowed({ operation: "resolve", ipAddress }),
      ).resolves.toBeUndefined();
    }
  });

  it("throws CaptchaRequiredError once the warning threshold is crossed, when Turnstile is configured and no captchaToken is given", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = "secret";
    const ipAddress = freshIp();
    const warningPoint = Math.ceil(RESOLVE_IP_LIMIT * 0.5);
    for (let i = 0; i < warningPoint - 1; i++) {
      await assertUploadAllowed({ operation: "resolve", ipAddress });
    }
    await expect(assertUploadAllowed({ operation: "resolve", ipAddress })).rejects.toBeInstanceOf(
      CaptchaRequiredError,
    );
  });

  it("lets a caller through the warning gate with a verified captchaToken, without exempting them from the hard limit", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );
    const ipAddress = freshIp();
    const warningPoint = Math.ceil(RESOLVE_IP_LIMIT * 0.5);
    let callsMade = 0;
    for (; callsMade < warningPoint - 1; callsMade++) {
      await assertUploadAllowed({ operation: "resolve", ipAddress });
    }

    // The next call (count reaches warningPoint) crosses the warning
    // threshold - a verified captchaToken lets it through anyway.
    await expect(
      assertUploadAllowed({ operation: "resolve", ipAddress, captchaToken: "solved" }),
    ).resolves.toBeUndefined();
    callsMade += 1;

    // Still enforced: keep going, with a (re-verified) captchaToken on
    // every call, right up to the hard limit - the hard limit cannot be
    // bought off by solving a challenge.
    for (; callsMade < RESOLVE_IP_LIMIT; callsMade++) {
      await assertUploadAllowed({ operation: "resolve", ipAddress, captchaToken: "solved" });
    }
    // One more call now exceeds RESOLVE_IP_LIMIT - throttled regardless of captchaToken.
    await expect(
      assertUploadAllowed({ operation: "resolve", ipAddress, captchaToken: "solved" }),
    ).rejects.toBeInstanceOf(UploadThrottledError);
  });

  it("keeps throwing CaptchaRequiredError when a captchaToken is given but fails verification", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
    );
    const ipAddress = freshIp();
    const warningPoint = Math.ceil(RESOLVE_IP_LIMIT * 0.5);
    for (let i = 0; i < warningPoint - 1; i++) {
      await assertUploadAllowed({ operation: "resolve", ipAddress });
    }

    await expect(
      assertUploadAllowed({ operation: "resolve", ipAddress, captchaToken: "wrong" }),
    ).rejects.toBeInstanceOf(CaptchaRequiredError);
  });

  it("never applies the captcha gate to the token/company-scoped upload rules", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = "secret";
    const tokenHash = "b".repeat(64);
    // Cross well past 50% of UPLOAD_TOKEN_LIMIT (5) using a fresh IP each
    // time so the IP-scoped rule never itself crosses its own warning
    // threshold - only the token-scoped rule is anywhere near its limit.
    for (let i = 0; i < UPLOAD_TOKEN_LIMIT - 1; i++) {
      await expect(
        assertUploadAllowed({ operation: "upload", ipAddress: freshIp(), tokenHash }),
      ).resolves.toBeUndefined();
    }
  });
});

describe("assertUploadAllowed - concurrency (Definition of Done)", () => {
  it("under N parallel calls against the same IP/operation, exactly RESOLVE_IP_LIMIT succeed and the rest are throttled", async () => {
    const ipAddress = freshIp();
    const N = RESOLVE_IP_LIMIT * 2;

    const outcomes = await Promise.allSettled(
      Array.from({ length: N }, () => assertUploadAllowed({ operation: "resolve", ipAddress })),
    );

    const succeeded = outcomes.filter((o) => o.status === "fulfilled").length;
    const throttled = outcomes.filter(
      (o) => o.status === "rejected" && o.reason instanceof UploadThrottledError,
    ).length;

    expect(succeeded).toBe(RESOLVE_IP_LIMIT);
    expect(throttled).toBe(N - RESOLVE_IP_LIMIT);
  });

  it("under N parallel uploads against the same company, exactly UPLOAD_COMPANY_DAILY_LIMIT succeed", async () => {
    const companyId = "22222222-2222-2222-2222-222222222222";
    const N = UPLOAD_COMPANY_DAILY_LIMIT + 25;

    const outcomes = await Promise.allSettled(
      Array.from({ length: N }, (_v, i) =>
        assertUploadAllowed({
          operation: "upload",
          ipAddress: freshIp(),
          tokenHash: `concurrent-token-${i}`,
          companyId,
        }),
      ),
    );

    const succeeded = outcomes.filter((o) => o.status === "fulfilled").length;
    expect(succeeded).toBe(UPLOAD_COMPANY_DAILY_LIMIT);
  }, 20_000);
});
