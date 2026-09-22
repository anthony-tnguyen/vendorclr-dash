import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for "no production email path bypasses suppression".
 *
 * Node: the only code allowed to call an EmailSender's send() is
 * sendUnlessSuppressed() in src/workflows/suppression.ts. Anything else that
 * sends mail must go through it.
 *
 * Deno Edge Functions: every function that talks to Resend must route every
 * send through its own sendUnlessSuppressed() twin (which calls
 * public.is_email_suppressed), or - send-renewal-reminders, which builds its
 * request inline - must ask is_email_suppressed before its Resend call.
 *
 * Crude by design (source text, not an AST), but it fails loudly the day
 * someone adds a new send path without the gate, which is the regression
 * that matters.
 */

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const rel = (path: string) => relative(ROOT, path).replace(/\\/g, "/");

describe("suppression coverage", () => {
  it("only sendUnlessSuppressed() hands mail to the Node email sender", () => {
    const offenders = walk(join(ROOT, "src"))
      .filter((file) => !/src\/tests\//.test(rel(file)))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        const sendsDirectly =
          /getEmailSender\(\)\s*\.send\(/.test(source) || /\bsender\.send\(/.test(source);
        return sendsDirectly && rel(file) !== "src/workflows/suppression.ts";
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the old unguarded createUploadRequest() path is gone", () => {
    const users = walk(join(ROOT, "src"))
      .filter((file) =>
        /createUploadRequest\(\{|const createUploadRequest\b|import[^;]*\bcreateUploadRequest\b/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map(rel);
    expect(users).toEqual([]);
  });

  it("every Edge Function that calls Resend checks suppression first", () => {
    const functionsDir = join(ROOT, "supabase", "functions");
    const senders = walk(functionsDir).filter((file) =>
      /fetch\(RESEND_ENDPOINT/.test(readFileSync(file, "utf8")),
    );
    expect(senders.length).toBeGreaterThan(0);

    for (const file of senders) {
      const source = readFileSync(file, "utf8");
      expect(source, rel(file)).toMatch(/rpc\(\s*"is_email_suppressed"/);

      const viaHelper = source.match(/sendViaResend\(/g)?.length ?? 0;
      if (viaHelper > 0) {
        // One definition + exactly one call, the one inside the guard.
        expect(viaHelper, `${rel(file)}: sendViaResend called outside the guard`).toBe(2);
        expect(source).toMatch(/return sendViaResend\(resendApiKey, input\);/);
      } else {
        expect(source.indexOf("is_email_suppressed")).toBeLessThan(
          source.indexOf("fetch(RESEND_ENDPOINT"),
        );
      }
    }
  });
});
