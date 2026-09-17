import { describe, expect, it } from "vitest";

import {
  artifactFileName,
  buildSmokeArtifact,
  parseSmokeArgs,
  type SmokeCaseResult,
} from "../../scripts/smoke-production";

/**
 * Task 13 - unit tests for smoke-production.ts's own pure logic (argument
 * parsing, artifact formatting), matching the established convention
 * (vendor-import.test.ts / data-lifecycle.test.ts) of testing a script's
 * TypeScript logic in isolation rather than requiring a live Supabase
 * connection for the test suite itself. The script's actual smoke cases
 * (caseHappyPath, caseBounceScenario, etc.) call a real Supabase project by
 * design - see the script's own docblock - and are exercised only by
 * actually running it against staging, not by this file.
 */

describe("parseSmokeArgs", () => {
  it("reads --env from argv", () => {
    const args = parseSmokeArgs(["--env=staging"], {});
    expect(args.env).toBe("staging");
    expect(args.baseUrl).toBeNull();
    expect(args.outDir).toBe("./smoke-artifacts");
  });

  it("accepts a space-separated flag value", () => {
    const args = parseSmokeArgs(["--env", "production"], {});
    expect(args.env).toBe("production");
  });

  it("reads --base-url and --out", () => {
    const args = parseSmokeArgs(
      ["--env=staging", "--base-url=https://staging.example.com", "--out=/tmp/artifacts"],
      {},
    );
    expect(args.baseUrl).toBe("https://staging.example.com");
    expect(args.outDir).toBe("/tmp/artifacts");
  });

  it("falls back to SMOKE_TARGET_ENV / SMOKE_BASE_URL / SMOKE_OUT_DIR env vars when no flag is given", () => {
    const args = parseSmokeArgs([], {
      SMOKE_TARGET_ENV: "production",
      SMOKE_BASE_URL: "https://vendorclr.com",
      SMOKE_OUT_DIR: "./artifacts",
    });
    expect(args).toEqual({
      env: "production",
      baseUrl: "https://vendorclr.com",
      outDir: "./artifacts",
    });
  });

  it("prefers an explicit flag over the env var fallback", () => {
    const args = parseSmokeArgs(["--env=staging"], { SMOKE_TARGET_ENV: "production" });
    expect(args.env).toBe("staging");
  });

  it("throws for a missing env", () => {
    expect(() => parseSmokeArgs([], {})).toThrow(/--env must be one of/);
  });

  it("throws for an invalid env value", () => {
    expect(() => parseSmokeArgs(["--env=preprod"], {})).toThrow(/--env must be one of/);
  });
});

describe("buildSmokeArtifact", () => {
  const startedAt = new Date("2026-09-17T20:00:00.000Z");
  const finishedAt = new Date("2026-09-17T20:00:05.000Z");

  function makeCase(status: SmokeCaseResult["status"], name = "example_case"): SmokeCaseResult {
    return { name, status, detail: `${name} detail`, durationMs: 10 };
  }

  it("summarizes pass/fail/skip counts and reports overallResult=pass when nothing failed", () => {
    const artifact = buildSmokeArtifact({
      gitSha: "abc123",
      env: "staging",
      baseUrl: "https://staging.example.com",
      startedAt,
      finishedAt,
      cases: [makeCase("pass", "a"), makeCase("pass", "b"), makeCase("skip", "c")],
    });

    expect(artifact.summary).toEqual({ pass: 2, fail: 0, skip: 1 });
    expect(artifact.overallResult).toBe("pass");
    expect(artifact.gitSha).toBe("abc123");
    expect(artifact.env).toBe("staging");
    expect(artifact.baseUrl).toBe("https://staging.example.com");
    expect(artifact.startedAt).toBe(startedAt.toISOString());
    expect(artifact.finishedAt).toBe(finishedAt.toISOString());
    expect(artifact.cases).toHaveLength(3);
  });

  it("reports overallResult=fail as soon as any case fails, regardless of pass/skip counts", () => {
    const artifact = buildSmokeArtifact({
      gitSha: "def456",
      env: "production",
      baseUrl: null,
      startedAt,
      finishedAt,
      cases: [makeCase("pass", "a"), makeCase("fail", "b"), makeCase("skip", "c")],
    });

    expect(artifact.summary).toEqual({ pass: 1, fail: 1, skip: 1 });
    expect(artifact.overallResult).toBe("fail");
  });

  it("handles zero cases without throwing", () => {
    const artifact = buildSmokeArtifact({
      gitSha: "abc123",
      env: "staging",
      baseUrl: null,
      startedAt,
      finishedAt,
      cases: [],
    });
    expect(artifact.summary).toEqual({ pass: 0, fail: 0, skip: 0 });
    expect(artifact.overallResult).toBe("pass");
  });
});

describe("artifactFileName", () => {
  it("builds a filesystem-safe name from env and startedAt", () => {
    const artifact = buildSmokeArtifact({
      gitSha: "abc123",
      env: "staging",
      baseUrl: null,
      startedAt: new Date("2026-09-17T20:00:00.000Z"),
      finishedAt: new Date("2026-09-17T20:00:05.000Z"),
      cases: [],
    });
    const name = artifactFileName(artifact);
    expect(name).toBe("staging-2026-09-17T20-00-00-000Z.json");
    expect(name).not.toMatch(/:/);
  });
});
