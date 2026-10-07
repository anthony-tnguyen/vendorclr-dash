import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDb } from "./harness";

/**
 * Regression coverage for a real gap found by Supabase's own advisor after
 * applying these migrations to a live project (`get_advisors`, type
 * "security") - not something this suite caught on its own.
 *
 * Migration 1 originally did `revoke execute on function ... from public` on
 * every RLS-primitive function, intending anon to have no access. On the live
 * project, `anon` could still execute every one of them. The cause: Supabase
 * applies `alter default privileges in schema public grant execute on
 * functions to anon, authenticated, service_role` at project creation, which
 * grants EXECUTE to those roles *directly* at function-creation time - a
 * separate grant `revoke ... from public` never touches, since PUBLIC is a
 * pseudo-role and this is a named-role grant. The harness now applies the same
 * default-privileges rule (see harness.ts BOOTSTRAP) specifically so this
 * class of bug is visible here instead of only in production.
 *
 * The fix migration (20260902000100_security_and_performance_hardening.sql)
 * revokes from the named roles directly.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

async function canExecute(role: "anon" | "authenticated", fnSignature: string): Promise<boolean> {
  const result = await db.query<{ can_exec: boolean }>(
    `select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as can_exec`,
    [role, fnSignature],
  );
  return result.rows[0]?.can_exec ?? false;
}

describe("RLS-primitive functions: authenticated yes, anon no", () => {
  // authenticated genuinely needs EXECUTE - RLS policies invoke these as the
  // querying role regardless of SECURITY DEFINER - so only anon is checked
  // as "must be false" here; authenticated is asserted true to catch a
  // regression that breaks the app, not just one that over-grants.
  const fns = [
    "public.current_company_ids()",
    "public.is_platform_admin()",
    "public.has_company_role(uuid, text[])",
    "public.can_write_company(uuid)",
    "public.shares_company_with(uuid)",
    "public.current_user_id()",
    "public.create_signup_invite(text, text)",
    "public.set_company_feature_flag(uuid, text, boolean)",
  ];

  it.each(fns)("anon cannot execute %s", async (fn) => {
    expect(await canExecute("anon", fn)).toBe(false);
  });

  it.each(fns)("authenticated can execute %s", async (fn) => {
    expect(await canExecute("authenticated", fn)).toBe(true);
  });
});

describe("create_company_for_current_user(): no longer callable directly", () => {
  // Used to sit in the "authenticated yes" group above. It bypassed the
  // signup_invites gate entirely (no invite check of its own), and nothing
  // in the app calls it, so its EXECUTE grant was revoked - see the gated
  // signup migration. Its own describe block, not folded into the
  // trigger-only group below, because it isn't a trigger function at all.
  const fn = "public.create_company_for_current_user(text, text)";

  it("anon cannot execute it", async () => {
    expect(await canExecute("anon", fn)).toBe(false);
  });

  it("authenticated cannot execute it either, now", async () => {
    expect(await canExecute("authenticated", fn)).toBe(false);
  });
});

describe("trigger-only functions: no one calls these directly", () => {
  const fns = [
    "public.assert_company_matches_vendor()",
    "public.assert_task_company_matches_vendor()",
    "public.handle_new_user()",
    "public.seed_vendor_compliance_items()",
    "public.set_audit_log_actor()",
    "public.assert_company_matches_email_outbox()",
    "public.set_signup_invite_defaults()",
    "public.record_project_workflow_audit()",
    "public.record_requirement_rule_audit()",
  ];

  it.each(fns)("anon cannot execute %s", async (fn) => {
    expect(await canExecute("anon", fn)).toBe(false);
  });

  it.each(fns)("authenticated cannot execute %s", async (fn) => {
    expect(await canExecute("authenticated", fn)).toBe(false);
  });

  it("triggers still fire despite the revoked EXECUTE grant", async () => {
    // Firing as a trigger does not require EXECUTE privilege - only direct
    // invocation does. This is the check that would catch a revoke that went
    // too far and silently broke signup or vendor creation.
    const company = await db.query<{ id: string }>(
      `insert into public.companies (name) values ('Grant Check Co') returning id`,
    );
    const companyId = company.rows[0]!.id;

    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Grant Check Vendor', 'Roofing')
       returning id`,
      [companyId],
    );

    const items = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_compliance_items where vendor_id = $1`,
      [vendor.rows[0]!.id],
    );
    expect(items.rows[0]?.n).toBe(5);
  });
});
