#!/usr/bin/env node
/**
 * Supabase drift check - compares what this repo commits against what the live
 * hosted projects actually have. The audit that prompted this (rec. #5) found
 * CI green while a committed migration sat undeployed and the hosted RPC was
 * broken: nothing in the push pipeline ever looks at the live projects. This
 * script is that missing look.
 *
 * It is deliberately NOT a required push check. It talks to the Supabase
 * Management API (live state, network, auth), which is exactly the kind of
 * flaky, credential-bound dependency that must never block an ordinary PR.
 * `.github/workflows/supabase-drift.yml` runs it on a schedule and on demand,
 * the same decoupling staging-smoke.yml uses. Run locally with:
 *
 *   SUPABASE_ACCESS_TOKEN=... bun run drift:check
 *
 * Without SUPABASE_ACCESS_TOKEN it prints a warning and exits 0 (a scheduled
 * run with no token configured is visible as a warning, not a hard failure).
 *
 * CROSS-REPO REALITY (the subtlety a naive check gets wrong): the hosted
 * project is shared with the sibling `vendorclear` marketing-site repo, so the
 * ledger is the UNION of two repos' migrations and the Edge Functions include
 * vendorclear's. The check is therefore directional:
 *
 *   - FAIL  - a migration committed HERE is absent from a project's ledger
 *             (true deploy-lag - the thing the audit cares about), or a
 *             function's deployed verify_jwt disagrees with config.toml.
 *   - WARN  - a ledger/function entry the live project has that is neither in
 *             this repo nor in supabase/drift-allowlist.json (an unrecognised
 *             object - probably a new vendorclear one to allow-list, possibly a
 *             genuine out-of-band change to investigate); also prod<->staging
 *             divergence, and dash functions with no verify_jwt declared.
 *
 * What this does NOT yet do (left for a follow-up that can be validated against
 * the live API on its first run): compare Edge Function SOURCE hashes (the
 * deployed `ezbr_sha256` is a build-output hash, not reproducible from source
 * without replicating Supabase's bundler) and assert the required Edge Function
 * SECRETS are present by name (GET /v1/projects/{ref}/secrets). Both are noted
 * in the audit; neither is safe to author blind.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const FUNCTIONS_DIR = join(REPO_ROOT, "supabase", "functions");
const CONFIG_TOML = join(REPO_ROOT, "supabase", "config.toml");
const ALLOWLIST_FILE = join(REPO_ROOT, "supabase", "drift-allowlist.json");

const MANAGEMENT_API = "https://api.supabase.com";

const PROJECTS = [
  {
    label: "production",
    ref: process.env["SUPABASE_PROD_PROJECT_REF"]?.trim() || "fzrcowwonezflydicpbd",
  },
  {
    label: "staging",
    ref: process.env["SUPABASE_STAGING_PROJECT_REF"]?.trim() || "ukbgjriqszthtgwxyirr",
  },
] as const;

type Severity = "fail" | "warn";

interface Finding {
  severity: Severity;
  message: string;
}

interface Allowlist {
  foreignMigrations: string[];
  foreignFunctions: string[];
}

interface RemoteFunction {
  slug: string;
  verifyJwt: boolean | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrationName(file: string): string {
  return file.replace(/\.sql$/, "").replace(/^\d+_/, "");
}

function localMigrationNames(): Set<string> {
  return new Set(
    readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .map(migrationName),
  );
}

function localFunctionSlugs(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
    .map((entry) => entry.name);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readAllowlist(): Allowlist {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8"));
    const record = (parsed ?? {}) as Record<string, unknown>;
    return {
      foreignMigrations: stringArray(record["foreignMigrations"]),
      foreignFunctions: stringArray(record["foreignFunctions"]),
    };
  } catch (error) {
    console.warn(`drift-allowlist.json unreadable (${errorMessage(error)}); treating as empty.`);
    return { foreignMigrations: [], foreignFunctions: [] };
  }
}

/** Parses `verify_jwt` out of every `[functions.<slug>]` block in config.toml. */
function declaredVerifyJwt(): Map<string, boolean> {
  const toml = readFileSync(CONFIG_TOML, "utf8");
  const declarations = new Map<string, boolean>();
  const blockPattern = /\[functions\.([a-z0-9-]+)\]([^[]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(toml)) !== null) {
    const slug = match[1];
    const block = match[2];
    if (slug === undefined || block === undefined) continue;
    const verifyMatch = /verify_jwt\s*=\s*(true|false)/i.exec(block);
    if (verifyMatch && verifyMatch[1] !== undefined) {
      declarations.set(slug, verifyMatch[1].toLowerCase() === "true");
    }
  }
  return declarations;
}

async function responseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

async function queryLedgerNames(ref: string, token: string): Promise<Set<string>> {
  const response = await fetch(`${MANAGEMENT_API}/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "select name from supabase_migrations.schema_migrations order by version",
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await responseText(response)}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("ledger query returned a non-array body");
  const names = new Set<string>();
  for (const row of body) {
    if (row && typeof row === "object") {
      const name = (row as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
  }
  return names;
}

async function listFunctions(ref: string, token: string): Promise<RemoteFunction[]> {
  const response = await fetch(`${MANAGEMENT_API}/v1/projects/${ref}/functions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await responseText(response)}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("functions list returned a non-array body");
  const functions: RemoteFunction[] = [];
  for (const entry of body) {
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const slug = record["slug"];
      if (typeof slug === "string" && slug.length > 0) {
        const verifyJwt = record["verify_jwt"];
        functions.push({ slug, verifyJwt: typeof verifyJwt === "boolean" ? verifyJwt : null });
      }
    }
  }
  return functions;
}

async function main(): Promise<void> {
  const token = process.env["SUPABASE_ACCESS_TOKEN"]?.trim();
  if (!token) {
    console.log("::warning::SUPABASE_ACCESS_TOKEN not set - skipping Supabase drift check.");
    console.log("Set SUPABASE_ACCESS_TOKEN in Actions secrets to enable this check.");
    return;
  }

  const localMigrations = localMigrationNames();
  const localFunctions = localFunctionSlugs();
  const declaredJwt = declaredVerifyJwt();
  const allowlist = readAllowlist();
  const allowedMigrations = new Set(allowlist.foreignMigrations);
  const allowedFunctions = new Set(allowlist.foreignFunctions);
  const findings: Finding[] = [];
  const remoteFunctionsByProject = new Map<string, Map<string, boolean | null>>();

  for (const project of PROJECTS) {
    try {
      const ledger = await queryLedgerNames(project.ref, token);
      for (const name of localMigrations) {
        if (!ledger.has(name)) {
          findings.push({
            severity: "fail",
            message: `[${project.label}] migration "${name}" is committed but absent from the ledger (not deployed).`,
          });
        }
      }
      for (const name of ledger) {
        if (!localMigrations.has(name) && !allowedMigrations.has(name)) {
          findings.push({
            severity: "warn",
            message: `[${project.label}] ledger has migration "${name}", which is not in this repo or the drift allow-list - confirm its owner (likely vendorclear) and allow-list it, or investigate.`,
          });
        }
      }
    } catch (error) {
      findings.push({
        severity: "fail",
        message: `[${project.label}] could not read the migration ledger: ${errorMessage(error)}`,
      });
    }

    try {
      const remoteFunctions = await listFunctions(project.ref, token);
      const byslug = new Map<string, boolean | null>();
      for (const fn of remoteFunctions) byslug.set(fn.slug, fn.verifyJwt);
      remoteFunctionsByProject.set(project.label, byslug);

      for (const fn of remoteFunctions) {
        const declared = declaredJwt.get(fn.slug);
        if (declared !== undefined && fn.verifyJwt !== null && declared !== fn.verifyJwt) {
          findings.push({
            severity: "fail",
            message: `[${project.label}] function "${fn.slug}" is deployed with verify_jwt=${fn.verifyJwt} but config.toml declares ${declared}.`,
          });
        }
        if (!localFunctions.includes(fn.slug) && !allowedFunctions.has(fn.slug)) {
          findings.push({
            severity: "warn",
            message: `[${project.label}] function "${fn.slug}" is deployed but has no source directory in this repo or entry in the drift allow-list.`,
          });
        }
      }

      for (const slug of localFunctions) {
        if (!byslug.has(slug)) {
          findings.push({
            severity: "warn",
            message: `[${project.label}] function "${slug}" has a source directory here but is not deployed.`,
          });
        }
      }
    } catch (error) {
      findings.push({
        severity: "fail",
        message: `[${project.label}] could not list Edge Functions: ${errorMessage(error)}`,
      });
    }
  }

  // Functions present in this repo with no verify_jwt declared: config.toml does
  // not capture their deployed auth posture, which is how prod ended up running
  // several with verify_jwt=false that the repo never states.
  for (const slug of localFunctions) {
    if (!declaredJwt.has(slug) && !allowedFunctions.has(slug)) {
      findings.push({
        severity: "warn",
        message: `function "${slug}" has no verify_jwt declared in config.toml - add [functions.${slug}] so its auth posture is reviewed and reproducible.`,
      });
    }
  }

  // prod <-> staging divergence: the same function should carry the same
  // verify_jwt in both environments.
  const prod = remoteFunctionsByProject.get("production");
  const staging = remoteFunctionsByProject.get("staging");
  if (prod && staging) {
    for (const [slug, prodJwt] of prod) {
      if (staging.has(slug)) {
        const stagingJwt = staging.get(slug) ?? null;
        if (prodJwt !== null && stagingJwt !== null && prodJwt !== stagingJwt) {
          findings.push({
            severity: "warn",
            message: `function "${slug}" has verify_jwt=${prodJwt} in production but ${stagingJwt} in staging.`,
          });
        }
      }
    }
  }

  const fails = findings.filter((finding) => finding.severity === "fail");
  const warns = findings.filter((finding) => finding.severity === "warn");

  console.log(`Supabase drift check: ${fails.length} failure(s), ${warns.length} warning(s).\n`);
  for (const finding of fails) console.log(`::error::${finding.message}`);
  for (const finding of warns) console.log(`::warning::${finding.message}`);
  if (findings.length === 0) {
    console.log("No drift detected between the repo and the hosted projects.");
  }

  process.exitCode = fails.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("check-supabase-drift failed:", errorMessage(error));
  process.exitCode = 1;
});
