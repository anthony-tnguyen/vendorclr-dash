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
`;

/**
 * Supabase grants these by default. Without them `set role authenticated` cannot
 * reach the tables at all, and every RLS assertion would pass vacuously.
 */
const DEFAULT_GRANTS = `
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant all on all sequences in schema public to anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

/** A fresh in-memory database with every migration applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(BOOTSTRAP);

  for (const file of migrationFiles()) {
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
  const meta = user.companyName ? JSON.stringify({ company_name: user.companyName }) : "{}";
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
    [user.id, user.email, meta],
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
