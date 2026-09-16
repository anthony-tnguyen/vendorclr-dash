#!/usr/bin/env node
/**
 * Task 7 - a standalone operations verification script, not application
 * code. Run by hand (or from a deploy checklist) after DNS changes, a new
 * sending domain, or a Resend webhook secret rotation - not on a schedule,
 * and not imported by anything in src/**.
 *
 * Node-only APIs (`node:dns/promises`) are acceptable here unlike
 * everywhere else in this project: this never runs in the Cloudflare
 * Workers request path (see vite.config.ts's src/server/** exclusion and
 * every *.server.ts file's own docblock for why that restriction exists
 * elsewhere) - it's a script a person runs from their own machine or CI,
 * the same category as `supabase` CLI commands already used to deploy this
 * project.
 *
 * Two checks:
 *
 *   1. DNS TXT lookups for SPF/DKIM/DMARC on the configured sending
 *      domain - resend.com (and every other ESP) requires all three to be
 *      correctly published for mail to land in the inbox rather than spam
 *      or get rejected outright. Reports pass/fail/missing for each; does
 *      not attempt to fix anything.
 *
 *   2. Prints the already-established "is resend-webhook live and
 *      verifying signatures" check as a copy-pasteable curl command - see
 *      the "Deployment verification" section this task adds to
 *      supabase/README.md for the full technique and why a 401 response is
 *      the PASSING outcome, not a failure. This script does not perform
 *      that HTTP call itself (it would need RESEND_WEBHOOK_SECRET or a
 *      forged one to do anything more than what curl already shows), it
 *      just surfaces the exact command an operator should run and what to
 *      expect back.
 *
 * Usage:
 *   bun scripts/check-email-deliverability.ts [domain] [dkimSelector]
 *
 *   domain        - defaults to compliance.vendorclr.com, the FROM_ADDRESS
 *                    domain in src/workflows/emailSender.ts.
 *   dkimSelector  - defaults to "resend", Resend's own default DKIM
 *                    selector (resend.com/docs/dashboard/domains/introduction).
 *                    Override if the domain was configured with a custom one.
 */

import { resolveTxt } from "node:dns/promises";

const DEFAULT_DOMAIN = "compliance.vendorclr.com";
const DEFAULT_DKIM_SELECTOR = "resend";
const SUPABASE_PROJECT_URL_HINT = "https://<project-ref>.supabase.co/functions/v1/resend-webhook";

type CheckResult = "pass" | "fail" | "missing";

interface CheckOutcome {
  label: string;
  hostname: string;
  result: CheckResult;
  detail: string;
}

/**
 * Never throws - a DNS resolver problem (no network, a broken resolv.conf,
 * a firewalled sandbox) is reported as its own failed check, not a crash
 * that kills every other check this script would otherwise still be able
 * to report. ENODATA/ENOTFOUND (the record genuinely does not exist) is
 * distinguished from every other resolver error (SERVFAIL, ECONNREFUSED,
 * timeouts, ...) via the returned `resolverError`, so a caller can tell
 * "this domain has no such record" apart from "the lookup itself failed."
 */
async function lookupTxt(
  hostname: string,
): Promise<{ records: string[]; resolverError: string | null }> {
  try {
    const raw = await resolveTxt(hostname);
    return { records: raw.map((chunks) => chunks.join("")), resolverError: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return { records: [], resolverError: null };
    return {
      records: [],
      resolverError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkSpf(domain: string): Promise<CheckOutcome> {
  const { records, resolverError } = await lookupTxt(domain);
  if (resolverError)
    return {
      label: "SPF",
      hostname: domain,
      result: "fail",
      detail: `DNS lookup failed: ${resolverError}`,
    };
  const spf = records.find((r) => r.toLowerCase().startsWith("v=spf1"));
  return {
    label: "SPF",
    hostname: domain,
    result: spf ? "pass" : records.length > 0 ? "fail" : "missing",
    detail:
      spf ??
      (records.length > 0
        ? "TXT records exist but none start with v=spf1"
        : "no TXT records found"),
  };
}

async function checkDkim(domain: string, selector: string): Promise<CheckOutcome> {
  const hostname = `${selector}._domainkey.${domain}`;
  const { records, resolverError } = await lookupTxt(hostname);
  if (resolverError)
    return {
      label: "DKIM",
      hostname,
      result: "fail",
      detail: `DNS lookup failed: ${resolverError}`,
    };
  const dkim = records.find((r) => r.toLowerCase().includes("v=dkim1"));
  return {
    label: "DKIM",
    hostname,
    result: dkim ? "pass" : records.length > 0 ? "fail" : "missing",
    detail:
      dkim ??
      (records.length > 0 ? "TXT record(s) exist but none contain v=DKIM1" : "no TXT record found"),
  };
}

async function checkDmarc(domain: string): Promise<CheckOutcome> {
  const hostname = `_dmarc.${domain}`;
  const { records, resolverError } = await lookupTxt(hostname);
  if (resolverError)
    return {
      label: "DMARC",
      hostname,
      result: "fail",
      detail: `DNS lookup failed: ${resolverError}`,
    };
  const dmarc = records.find((r) => r.toLowerCase().startsWith("v=dmarc1"));
  return {
    label: "DMARC",
    hostname,
    result: dmarc ? "pass" : records.length > 0 ? "fail" : "missing",
    detail:
      dmarc ??
      (records.length > 0
        ? "TXT record(s) exist but none start with v=DMARC1"
        : "no TXT record found"),
  };
}

function printOutcome(outcome: CheckOutcome): void {
  const icon = outcome.result === "pass" ? "PASS" : outcome.result === "fail" ? "FAIL" : "MISSING";
  console.log(`[${icon}] ${outcome.label} (${outcome.hostname})`);
  console.log(`       ${outcome.detail}`);
}

async function main(): Promise<void> {
  const [, , domainArg, selectorArg] = process.argv;
  const domain = domainArg ?? DEFAULT_DOMAIN;
  const dkimSelector = selectorArg ?? DEFAULT_DKIM_SELECTOR;

  console.log(`Checking email deliverability DNS records for ${domain}\n`);

  const outcomes = await Promise.all([
    checkSpf(domain),
    checkDkim(domain, dkimSelector),
    checkDmarc(domain),
  ]);
  for (const outcome of outcomes) printOutcome(outcome);

  console.log("\nResend webhook signature round trip (see supabase/README.md's");
  console.log('"Deployment verification" section for the full technique):\n');
  console.log(`  curl -i -X POST ${SUPABASE_PROJECT_URL_HINT} \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"type":"email.bounced","created_at":"2026-01-01T00:00:00Z","data":{}}'`);
  console.log("\n  Expected: HTTP 401 with a JSON body naming the missing/invalid signature.");
  console.log("  A 401 here is PASS - it proves the function is live and refuses an");
  console.log("  unsigned call, per the fail-closed design in supabase/functions/");
  console.log("  resend-webhook/index.ts. A 200, a connection failure, or any other");
  console.log("  status is a problem worth investigating before relying on this endpoint.");

  const anyFailing = outcomes.some((o) => o.result !== "pass");
  process.exitCode = anyFailing ? 1 : 0;
}

main().catch((error) => {
  console.error(
    "check-email-deliverability failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
