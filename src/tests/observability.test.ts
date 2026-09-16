import { describe, expect, it } from "vitest";
import { logOperational, redact } from "@/lib/observability/logger.server";
import {
  buildEnvelope,
  buildErrorEvent,
  generateSentryEventId,
  parseDsn,
} from "@/lib/observability/sentryEnvelope";

/**
 * Real test cases for redact(), not a docblock promise - the plan is
 * explicit that this needs actual coverage of an email address, a
 * token-shaped string, a policy number under a suspicious key, a filename,
 * and a JWT, each proven masked, plus proof that ordinary operational data
 * survives untouched.
 */
describe("redact()", () => {
  it("masks an email address wherever it appears in a string", () => {
    expect(redact("contact rosa@halstead.test about the renewal")).toBe(
      "contact [REDACTED] about the renewal",
    );
  });

  it("masks an email address nested inside an object, regardless of key name", () => {
    expect(redact({ note: "cc bob@rival.test on this" })).toEqual({
      note: "cc [REDACTED] on this",
    });
  });

  it("masks a value under a key named like a token/secret, whatever the value looks like", () => {
    expect(redact({ token_hash: "not-actually-hex-shaped" })).toEqual({
      token_hash: "[REDACTED]",
    });
  });

  it("masks a value under a key named policyNumber (camelCase)", () => {
    expect(redact({ policyNumber: "GL-2026-004471" })).toEqual({ policyNumber: "[REDACTED]" });
  });

  it("masks a value under a key named policy_number (snake_case)", () => {
    expect(redact({ policy_number: "GL-2026-004471" })).toEqual({ policy_number: "[REDACTED]" });
  });

  it("masks a value under a key named fileName/file_name", () => {
    expect(redact({ fileName: "coi.pdf", file_name: "coi.pdf" })).toEqual({
      fileName: "[REDACTED]",
      file_name: "[REDACTED]",
    });
  });

  it("masks a bare filename with a document extension, even under an unsuspicious key", () => {
    expect(redact({ note: "attached vendor-coi-2026.pdf for review" })).toEqual({
      note: "attached [REDACTED] for review",
    });
  });

  it("masks a Bearer token", () => {
    expect(redact("Authorization: Bearer sk_live_abcdef123456")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("masks a prefixed secret shape (whsec_/sk_/re_) even without a Bearer prefix", () => {
    expect(redact("secret is whsec_plJ3nmyCDGBKInavdOK15jsl")).toBe("secret is [REDACTED]");
  });

  it("masks a real Resend-key-shaped string", () => {
    expect(redact("using re_A1b2C3d4E5f6G7h8 to send")).toBe("using [REDACTED] to send");
  });

  it("does not redact ordinary English text that merely starts with a short secret prefix", () => {
    // A digit-free suffix after "re_"/"sk_" is ordinary text, not a key shape -
    // this app has no digit-free real secret. Regression test for a false
    // positive an earlier pattern produced (see logger.server.ts).
    expect(redact("re_evaluate the submission")).toBe("re_evaluate the submission");
    expect(redact("please re_upload the file")).toBe("please re_upload the file");
    expect(redact("sk_pending review")).toBe("sk_pending review");
  });

  it("masks a JWT-shaped string", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redact(`token=${jwt}`)).toBe("token=[REDACTED]");
  });

  it("masks a long hex hash (sha256-shaped)", () => {
    const hash = "a".repeat(64);
    expect(redact(`sha256=${hash}`)).toBe("sha256=[REDACTED]");
  });

  it("leaves ordinary operational data untouched", () => {
    const entry = { level: "info", event: "upload_completed", outcome: "success", count: 3 };
    expect(redact(entry)).toEqual(entry);
  });

  it("redacts recursively through nested objects and arrays", () => {
    expect(
      redact({
        vendor: { contactEmail: "vendor@example.test", name: "Corbett Steel" },
        attachments: ["cert.pdf", "waiver.docx"],
      }),
    ).toEqual({
      vendor: { contactEmail: "[REDACTED]", name: "Corbett Steel" },
      attachments: ["[REDACTED]", "[REDACTED]"],
    });
  });

  it("never throws and bottoms out on pathologically deep nesting", () => {
    let deep: unknown = "leaf@example.test";
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});

describe("logOperational()", () => {
  it("redacts an email address embedded in extra context before logging", () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      logOperational(
        { level: "info", event: "test_event", requestId: "req-1", outcome: "success" },
        { detail: "sent to owner@halstead.test" },
      );
    } finally {
      console.log = originalLog;
    }
    expect(lines[0]).not.toContain("owner@halstead.test");
    expect(lines[0]).toContain("[REDACTED]");
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "test_event", requestId: "req-1" });
  });

  it("routes an error-level entry to console.error", () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (line: string) => lines.push(line);
    try {
      logOperational({ level: "error", event: "boom", requestId: "req-2", outcome: "failure" });
    } finally {
      console.error = originalError;
    }
    expect(lines).toHaveLength(1);
  });
});

describe("sentryEnvelope: parseDsn()", () => {
  it("parses a standard DSN into an envelope ingestion URL", () => {
    const parsed = parseDsn("https://examplePublicKey@o0.ingest.sentry.io/1234567");
    expect(parsed?.envelopeUrl).toBe(
      "https://o0.ingest.sentry.io/api/1234567/envelope/?sentry_key=examplePublicKey&sentry_version=7",
    );
  });

  it("returns null for a DSN with no public key", () => {
    expect(parseDsn("https://o0.ingest.sentry.io/1234567")).toBeNull();
  });

  it("returns null for a DSN with no project id", () => {
    expect(parseDsn("https://examplePublicKey@o0.ingest.sentry.io/")).toBeNull();
  });

  it("returns null (never throws) for a malformed URL", () => {
    expect(parseDsn("not-a-url")).toBeNull();
  });
});

describe("sentryEnvelope: buildErrorEvent() / buildEnvelope()", () => {
  it("carries the release and environment as tags", () => {
    const event = buildErrorEvent({
      error: new Error("boom"),
      release: "abc123",
      environment: "production",
      tags: { release: "abc123", environment: "production" },
    });
    expect(event.tags).toEqual({ release: "abc123", environment: "production" });
    expect(event.exception?.values[0]).toMatchObject({ type: "Error", value: "boom" });
  });

  it("wraps a non-Error thrown value in an Error", () => {
    const event = buildErrorEvent({
      error: "just a string",
      release: "unknown",
      environment: "development",
    });
    expect(event.exception?.values[0]?.value).toBe("just a string");
  });

  it("produces newline-delimited envelope framing with three lines", () => {
    const event = buildErrorEvent({ error: new Error("x"), release: "r", environment: "e" });
    const envelope = buildEnvelope(event, "https://key@host/1");
    const lines = envelope.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event", content_type: "application/json" });
    expect(JSON.parse(lines[2]!)).toMatchObject({ event_id: event.event_id });
  });
});

describe("sentryEnvelope: generateSentryEventId()", () => {
  it("produces a 32-character lowercase hex string with no dashes", () => {
    const id = generateSentryEventId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
