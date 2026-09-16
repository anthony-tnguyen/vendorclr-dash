import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Applies supabase/migrations to a real Postgres and lets tests query it as a
 * specific signed-in user, so the RLS policies are exercised rather than assumed.
 *
 * PGlite is Postgres compiled to WASM: same planner, same RLS engine, same
 * constraint and trigger semantics, but no Docker daemon and no install. That
 * matters here because RLS fails *silently* - a broken policy returns rows instead
 * of raising - so these checks need to run everywhere, including CI, not only on a
 * machine where `supabase start` happens to work.
 *
 * What this does NOT cover: Supabase's real GoTrue. `auth.users` and `auth.uid()`
 * below are stubs matching the shape the migrations depend on. Email confirmation,
 * production JWT claim contents and service_role behavior still need a real
 * `supabase db reset` before shipping.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPABASE_DIR = join(HERE, "..");
const MIGRATIONS_DIR = join(SUPABASE_DIR, "migrations");

export const SEED_SQL = readFileSync(join(SUPABASE_DIR, "seed.sql"), "utf8");

/** The parts of a Supabase project the migrations assume already exist. */
const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema if not exists auth;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz not null default now()
  );

  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

  -- Real Supabase projects apply this at project creation. It grants EXECUTE
  -- to anon/authenticated DIRECTLY, on every function created afterwards -
  -- separately from the PUBLIC pseudo-role. "revoke ... from public" (which
  -- migration 1 originally did, before the hardening migration fixed it) does
  -- NOT touch this grant; only "revoke ... from anon" explicitly does. Without
  -- this line the harness would not reproduce the bug that shipped, and could
  -- not verify the fix - see function-grants.test.ts.
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  -- Minimal stand-in for Supabase Storage, which is not a schema PGlite ships
  -- with. Only what migration 4 depends on: the buckets/objects tables its
  -- INSERT and RLS policy touch, and foldername(), which storage's real
  -- implementation also exposes as a plain SQL helper on the object path.
  create schema if not exists storage;

  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz not null default now()
  );

  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text,
    owner uuid,
    created_at timestamptz not null default now()
  );

  -- Real Supabase projects ship storage.objects with RLS already on; migration
  -- 4 only adds a policy on top of that. Match it here or the policy is inert.
  alter table storage.objects enable row level security;

  create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$
    select case
      when array_length(string_to_array(name, '/'), 1) <= 1 then array[]::text[]
      else (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
    end
  $$;
`;

/**
 * Supabase grants these by default. Without them `set role authenticated` cannot
 * reach the tables at all, and every RLS assertion would pass vacuously.
 */
const DEFAULT_GRANTS = `
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant all on all sequences in schema public to anon, authenticated, service_role;

  -- Matches Supabase's real storage grants: broad table access, restricted by
  -- storage.objects RLS (the vendor_documents_bucket_read policy) same as any
  -- other table.
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
`;

/**
 * Migrations that create extensions PGlite cannot support: pg_cron and pg_net
 * both need a real background worker / real networking, which a single-process
 * WASM Postgres build does not have. `db:verify` cannot exercise these - they're
 * covered instead by get_advisors + a smoke test against the live hosted
 * project, same as anything else that needs the real stack (see supabase/README.md).
 *
 * Named explicitly, not pattern-matched, so a future migration is only ever
 * skipped here on purpose, never by accident.
 */
export const SKIPPED_IN_PGLITE: readonly string[] = [
  "20260902000600_schedule_renewal_reminders.sql",
  "20260903000400_schedule_automated_retries.sql",
  // Grants on the `cron` schema/tables, which PGlite never creates (see that
  // migration's own docblock) - same reason as the two above.
  "20260917000100_operations_cron_grants.sql",
  // References the `cron` schema (get_scheduled_job_run_history()) and is
  // only meaningful against the real project (get_database_size_bytes()) -
  // same reasoning.
  "20260917000200_operations_scheduled_job_functions.sql",
  // Task 8b - schedules process-document-jobs via cron.schedule()/pg_net,
  // same reasoning as the two scheduled-job migrations above.
  "20260917000700_schedule_document_processing_jobs.sql",
];

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

/** A fresh in-memory database with every PGlite-compatible migration applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(BOOTSTRAP);

  for (const file of migrationFiles()) {
    if (SKIPPED_IN_PGLITE.includes(file)) continue;
    try {
      await db.exec(readMigration(file));
    } catch (error) {
      throw new Error(
        `migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await db.exec(DEFAULT_GRANTS);
  return db;
}

export interface TestUser {
  id: string;
  email: string;
  companyName?: string;
}

/** Inserts into auth.users, which fires handle_new_user exactly as signup does. */
export async function signUp(db: PGlite, user: TestUser): Promise<void> {
  let inviteCode: string | null = null;

  if (user.companyName) {
    // Provisions a matching, valid invite so existing callers of signUp()
    // that pass companyName keep working under the new gate, without every
    // test needing to know about invites. Leaves the trigger's own code
    // generation and normalization in the loop rather than hand-rolling a
    // code here, so this exercises the same defaults path production uses.
    const invite = await db.query<{ code: string }>(
      `insert into public.signup_invites (email, company_name, expires_at)
       values ($1, $2, now() + interval '14 days')
       returning code`,
      [user.email, user.companyName],
    );
    inviteCode = invite.rows[0]!.code;
  }

  const meta = inviteCode ? { invite_code: inviteCode } : {};
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
    [user.id, user.email, JSON.stringify(meta)],
  );
}

export async function companyIdFor(db: PGlite, userId: string): Promise<string> {
  const result = await db.query<{ company_id: string }>(
    `select company_id from public.company_members where user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`user ${userId} has no company membership`);
  return row.company_id;
}

/**
 * Runs one statement as a signed-in, non-superuser role so RLS actually applies.
 * Superusers bypass RLS entirely, which would make every policy test meaningless.
 */
export async function asUser<T>(
  db: PGlite,
  userId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    await db.exec("begin");
    await db.exec("set local role authenticated");
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const result = await db.query<T>(sql, params);
    await db.exec("commit");
    return result.rows;
  } catch (error) {
    // A failed statement aborts the transaction; without this every later query
    // in the suite fails with "current transaction is aborted".
    try {
      await db.exec("rollback");
    } catch {
      /* already rolled back */
    }
    throw error;
  }
}

/** Asserts a write is refused by RLS rather than succeeding or erroring some other way. */
export async function expectDeniedByRls(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/row-level security|violates .*policy/i.test(message)) return;
    throw new Error(`expected an RLS denial, got a different error: ${message}`);
  }
  throw new Error("expected the operation to be denied by RLS, but it succeeded");
}
