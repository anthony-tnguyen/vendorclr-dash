# Gated Business Signup via Invite Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate `/signup` so a new business (company) account can only be created by redeeming a valid, admin-issued, email-locked invite code — enforced in the database, not just the client.

**Architecture:** A new `signup_invites` table holds admin-issued codes. The existing `handle_new_user` trigger on `auth.users` (which already provisions a company from client-supplied metadata) is extended to require and redeem a matching invite before creating a company; an invalid code raises, aborting the whole signup. A new admin page issues and revokes invites through a `SECURITY DEFINER` RPC; the signup form sends an invite code instead of a free-text company name. A second, previously-unused RPC (`create_company_for_current_user`) that bypassed this gate entirely has its `EXECUTE` grant revoked.

**Tech Stack:** Postgres/Supabase (PGlite-backed test harness in `supabase/tests`), React + TanStack Router/Query, hand-authored `db-types.ts`, Vitest.

**Reference:** `docs/superpowers/specs/2026-09-15-gated-signup-invites-design.md` is the approved design this plan implements.

---

## Task 1: `signup_invites` table, defaults trigger, RLS, and the `create_signup_invite` RPC

**Files:**
- Create: `supabase/migrations/20260915000100_gated_signup_invites.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Gates self-serve business signup behind an admin-issued, per-company,
-- email-locked invite code. See
-- docs/superpowers/specs/2026-09-15-gated-signup-invites-design.md for the
-- approved design this migration implements.

-- ---------------------------------------------------------------------------
-- signup_invites
-- ---------------------------------------------------------------------------

create table public.signup_invites (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  email         text not null,
  company_name  text not null check (length(btrim(company_name)) between 1 and 200),
  status        text not null default 'pending' check (status in ('pending', 'used', 'revoked')),
  expires_at    timestamptz not null,
  created_by    uuid references public.platform_admins (user_id),
  used_at       timestamptz,
  used_by       uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (code)
);

comment on table public.signup_invites is
  'Admin-issued, email-locked, single-use codes gating self-serve business signup. Redeemed by handle_new_user() during the auth.users insert.';

create trigger signup_invites_touch_updated_at
  before update on public.signup_invites
  for each row execute function public.touch_updated_at();

-- Generates a unique code and a 14-day expiry when the caller does not
-- supply one, and normalizes the email so the lookup in handle_new_user()
-- (added in the next migration) is case-insensitive.
create or replace function public.set_signup_invite_defaults()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  candidate text;
  attempts  int := 0;
begin
  new.email := lower(btrim(new.email));

  if new.code is null then
    loop
      candidate := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
      exit when not exists (select 1 from public.signup_invites where code = candidate);
      attempts := attempts + 1;
      if attempts > 5 then
        raise exception 'Could not generate a unique invite code';
      end if;
    end loop;
    new.code := candidate;
  else
    new.code := upper(btrim(new.code));
  end if;

  if new.expires_at is null then
    new.expires_at := now() + interval '14 days';
  end if;

  return new;
end;
$fn$;

create trigger signup_invites_set_defaults
  before insert on public.signup_invites
  for each row execute function public.set_signup_invite_defaults();

alter table public.signup_invites enable row level security;

-- Admin-only in every direction. Rows are never inserted directly by a
-- client - only through create_signup_invite() below - so there is
-- deliberately no insert policy; RLS denies insert to authenticated by
-- default with none defined.
create policy signup_invites_select on public.signup_invites
  for select to authenticated
  using (public.is_platform_admin());

create policy signup_invites_update on public.signup_invites
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- create_signup_invite(): the only way a row is ever inserted into
-- signup_invites. SECURITY DEFINER so it can insert despite the table
-- having no insert policy; the is_platform_admin() check below is what
-- actually gates it - same shape as create_company_for_current_user().
-- ---------------------------------------------------------------------------

create or replace function public.create_signup_invite(
  company_name text,
  email        text
)
returns public.signup_invites
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  result   public.signup_invites;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if length(btrim(coalesce(company_name, ''))) = 0 then
    raise exception 'company_name is required' using errcode = '22023';
  end if;
  if length(btrim(coalesce(email, ''))) = 0 then
    raise exception 'email is required' using errcode = '22023';
  end if;

  insert into public.signup_invites (company_name, email, created_by)
  values (btrim(company_name), email, admin_id)
  returning * into result;

  return result;
end;
$fn$;

revoke execute on function public.create_signup_invite(text, text) from public, anon, authenticated;
grant execute on function public.create_signup_invite(text, text) to authenticated;

revoke execute on function public.set_signup_invite_defaults() from public, anon, authenticated;
```

- [ ] **Step 2: Apply it and confirm the existing suite doesn't yet regress from schema alone**

Run: `npm run db:verify`
Expected: All existing `supabase/tests/*.test.ts` still PASS. (`handle_new_user` isn't touched until Task 2, so nothing yet depends on `invite_code`.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260915000100_gated_signup_invites.sql
git commit -m "$(cat <<'EOF'
Add signup_invites table, defaults trigger, RLS, and create_signup_invite RPC

First half of gating business signup behind admin-issued invite codes.
handle_new_user isn't wired to redeem these yet - that's the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Redeem invites in `handle_new_user`; close the `create_company_for_current_user` loophole

**Files:**
- Modify: `supabase/migrations/20260915000100_gated_signup_invites.sql`
- Modify: `supabase/tests/harness.ts:158-171`

- [ ] **Step 1: Append the `handle_new_user` redefinition and the loophole fix to the same migration file**

Add to the end of `supabase/migrations/20260915000100_gated_signup_invites.sql`:

```sql
-- ---------------------------------------------------------------------------
-- handle_new_user(): now redeems an invite code before creating a company.
-- Company creation used to be conditional on a client-supplied
-- company_name; it is now conditional on a client-supplied invite_code that
-- resolves to a pending, unexpired, email-matching invite. A missing,
-- invalid, expired, revoked or already-used code raises, which aborts the
-- whole auth.users insert - signUp() fails and no account is created.
--
-- No code at all still creates the profile with no company, same as
-- today's no-company_name path. That path is intentionally left open: it is
-- how a teammate is added to an *existing* company (direct company_members
-- insert, not through /signup), which this gate is not meant to cover - see
-- the "Non-goals" section of the design doc.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  requested_code text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')), '');
  invite         public.signup_invites;
  new_company    uuid;
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  if requested_code is not null then
    select * into invite
    from public.signup_invites
    where code = upper(requested_code)
      and status = 'pending'
    for update;

    if invite.id is null
       or invite.expires_at < now()
       or invite.email <> lower(new.email)
    then
      raise exception 'Invalid or expired invite code.';
    end if;

    insert into public.companies (name)
    values (left(invite.company_name, 200))
    returning id into new_company;

    insert into public.company_members (company_id, user_id, role, last_active_at)
    values (new_company, new.id, 'owner', now())
    on conflict (company_id, user_id) do nothing;

    update public.signup_invites
    set status = 'used', used_at = now(), used_by = new.id
    where id = invite.id;
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- create_company_for_current_user() bypassed the invite gate entirely - any
-- authenticated user could call it directly and get a company with no code
-- at all. It is not called anywhere in the app today (supabaseRepository.ts
-- only names it in an error message), so revoking EXECUTE closes the hole
-- without breaking anything that calls it.
-- ---------------------------------------------------------------------------

revoke execute on function public.create_company_for_current_user(text, text) from authenticated;
```

- [ ] **Step 2: Update the PGlite test harness so `signUp()` keeps working for every existing caller**

Every existing test that calls `signUp(db, { ..., companyName: "..." })` now needs a matching, valid invite behind the scenes, or `handle_new_user` will reject it. Make the harness provision one transparently so no test call site needs to change.

In `supabase/tests/harness.ts`, replace the `signUp` function (currently lines 164-171):

```typescript
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
```

- [ ] **Step 3: Run the full existing DB suite to confirm nothing else broke**

Run: `npm run db:verify`
Expected: All tests in `supabase/tests/*.test.ts` PASS, including `rls.test.ts`, `audit-log.test.ts`, and every other file that calls `signUp(db, { companyName: ... })`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260915000100_gated_signup_invites.sql supabase/tests/harness.ts
git commit -m "$(cat <<'EOF'
Gate handle_new_user on a redeemed invite code; close create_company_for_current_user loophole

Company creation during signup now requires a pending, unexpired,
email-matching signup_invites row - a missing or invalid code aborts the
whole auth.users insert. Also revokes EXECUTE on
create_company_for_current_user, an unused RPC that bypassed this gate
entirely. The PGlite test harness's signUp() helper now provisions a
matching invite transparently so every existing caller keeps working.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Behavioral test coverage for invite redemption

**Files:**
- Create: `supabase/tests/signup-invites.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * Behavior of the invite-gated signup path: signup_invites, the redemption
 * logic in handle_new_user(), and the create_signup_invite() RPC that is the
 * only way a row gets into that table. Grant-level checks (who may EXECUTE
 * which function) live in function-grants.test.ts, not here.
 */

const ADMIN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NON_ADMIN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let db: PGlite;

async function insertInvite(
  overrides: Partial<{
    code: string;
    email: string;
    companyName: string;
    status: "pending" | "used" | "revoked";
    expiresAt: string;
  }> = {},
): Promise<string> {
  const email = overrides.email ?? "owner@newco.test";
  const companyName = overrides.companyName ?? "New Co";
  const expiresAt = overrides.expiresAt ?? "now() + interval '14 days'";
  const status = overrides.status ?? "pending";

  const result = await db.query<{ code: string }>(
    `insert into public.signup_invites (code, email, company_name, status, expires_at)
     values (coalesce($1, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))), $2, $3, $4, ${expiresAt})
     returning code`,
    [overrides.code ?? null, email, companyName, status],
  );
  return result.rows[0]!.code;
}

beforeEach(async () => {
  db = await createTestDb();

  await signUp(db, { id: ADMIN, email: "admin@vendorclear.test" });
  await db.query(`insert into public.platform_admins (user_id) values ($1)`, [ADMIN]);
  await signUp(db, { id: NON_ADMIN, email: "member@rival.test" });
}, 60_000);

describe("handle_new_user redeems a valid invite", () => {
  it("creates the company from the invite's company_name, not any client input", async () => {
    const code = await insertInvite({ email: "owner@newco.test", companyName: "New Co" });
    const userId = "10000000-0000-0000-0000-000000000001";

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [userId, "owner@newco.test", JSON.stringify({ invite_code: code })],
    );

    const companyId = await companyIdFor(db, userId);
    const company = await db.query<{ name: string }>(
      `select name from public.companies where id = $1`,
      [companyId],
    );
    expect(company.rows[0]?.name).toBe("New Co");

    const membership = await db.query<{ role: string }>(
      `select role from public.company_members where company_id = $1 and user_id = $2`,
      [companyId, userId],
    );
    expect(membership.rows[0]?.role).toBe("owner");

    const invite = await db.query<{ status: string; used_by: string }>(
      `select status, used_by from public.signup_invites where code = $1`,
      [code],
    );
    expect(invite.rows[0]?.status).toBe("used");
    expect(invite.rows[0]?.used_by).toBe(userId);
  });

  it("matches the code case-insensitively", async () => {
    const code = await insertInvite({ email: "owner@lower.test", companyName: "Lower Co" });
    const userId = "10000000-0000-0000-0000-000000000002";

    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [userId, "owner@lower.test", JSON.stringify({ invite_code: code.toLowerCase() })],
    );

    await expect(companyIdFor(db, userId)).resolves.toBeTruthy();
  });
});

describe("handle_new_user rejects an invalid invite, aborting the whole signup", () => {
  async function attemptSignup(userId: string, email: string, code: string): Promise<Error> {
    try {
      await db.query(
        `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
        [userId, email, JSON.stringify({ invite_code: code })],
      );
      throw new Error("expected signup to be rejected, but it succeeded");
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async function expectNoTraceOfUser(userId: string): Promise<void> {
    const users = await db.query(`select 1 from auth.users where id = $1`, [userId]);
    expect(users.rows).toHaveLength(0);
    const profiles = await db.query(`select 1 from public.profiles where id = $1`, [userId]);
    expect(profiles.rows).toHaveLength(0);
  }

  it("rejects a code that does not exist", async () => {
    const userId = "20000000-0000-0000-0000-000000000001";
    const error = await attemptSignup(userId, "nobody@newco.test", "NOSUCHCODE");
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  it("rejects an expired code", async () => {
    const code = await insertInvite({
      email: "late@newco.test",
      expiresAt: "now() - interval '1 day'",
    });
    const userId = "20000000-0000-0000-0000-000000000002";
    const error = await attemptSignup(userId, "late@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  it("rejects a code redeemed with the wrong email", async () => {
    const code = await insertInvite({ email: "intended@newco.test" });
    const userId = "20000000-0000-0000-0000-000000000003";
    const error = await attemptSignup(userId, "someone-else@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  it("rejects a revoked code", async () => {
    const code = await insertInvite({ email: "revoked@newco.test", status: "revoked" });
    const userId = "20000000-0000-0000-0000-000000000004";
    const error = await attemptSignup(userId, "revoked@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(userId);
  });

  it("rejects a code that has already been used", async () => {
    const code = await insertInvite({ email: "reused@newco.test" });
    const firstUser = "20000000-0000-0000-0000-000000000005";
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [firstUser, "reused@newco.test", JSON.stringify({ invite_code: code })],
    );

    const secondUser = "20000000-0000-0000-0000-000000000006";
    const error = await attemptSignup(secondUser, "reused@newco.test", code);
    expect(error.message).toMatch(/invalid or expired invite code/i);
    await expectNoTraceOfUser(secondUser);
  });

  it("still creates a profile with no company when no code is sent at all", async () => {
    const userId = "20000000-0000-0000-0000-000000000007";
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}'::jsonb)`,
      [userId, "no-code@example.test"],
    );

    const profile = await db.query(`select 1 from public.profiles where id = $1`, [userId]);
    expect(profile.rows).toHaveLength(1);
    const membership = await db.query(`select 1 from public.company_members where user_id = $1`, [
      userId,
    ]);
    expect(membership.rows).toHaveLength(0);
  });
});

describe("create_signup_invite()", () => {
  it("lets a platform admin create a pending invite with a generated code and ~14-day expiry", async () => {
    const rows = await asUser<{
      code: string;
      status: string;
      expires_at: string;
      created_at: string;
    }>(
      db,
      ADMIN,
      `select code, status, expires_at, created_at from public.create_signup_invite($1, $2)`,
      ["Fresh Co", "owner@freshco.test"],
    );

    const invite = rows[0]!;
    expect(invite.status).toBe("pending");
    expect(invite.code).toMatch(/^[0-9A-F]{10}$/);

    const daysUntilExpiry =
      (new Date(invite.expires_at).getTime() - new Date(invite.created_at).getTime()) /
      (1000 * 60 * 60 * 24);
    expect(daysUntilExpiry).toBeGreaterThan(13);
    expect(daysUntilExpiry).toBeLessThan(15);
  });

  it("denies a non-admin", async () => {
    await expect(
      asUser(db, NON_ADMIN, `select public.create_signup_invite($1, $2)`, ["Rival Co", "x@rival.test"]),
    ).rejects.toThrow(/not authorized/i);
  });
});

describe("signup_invites RLS", () => {
  it("lets a platform admin select and update invites", async () => {
    const code = await insertInvite({ email: "visible@newco.test" });

    const rows = await asUser<{ code: string }>(
      db,
      ADMIN,
      `select code from public.signup_invites where code = $1`,
      [code],
    );
    expect(rows).toHaveLength(1);

    await asUser(db, ADMIN, `update public.signup_invites set status = 'revoked' where code = $1`, [
      code,
    ]);
    const after = await db.query<{ status: string }>(
      `select status from public.signup_invites where code = $1`,
      [code],
    );
    expect(after.rows[0]?.status).toBe("revoked");
  });

  it("hides invites from a non-admin", async () => {
    await insertInvite({ email: "hidden@newco.test" });

    const rows = await asUser<{ code: string }>(
      db,
      NON_ADMIN,
      `select code from public.signup_invites`,
    );
    expect(rows).toHaveLength(0);
  });

  it("denies a non-admin's update", async () => {
    const code = await insertInvite({ email: "protected@newco.test" });

    await expectDeniedByRls(() =>
      asUser(db, NON_ADMIN, `update public.signup_invites set status = 'revoked' where code = $1`, [
        code,
      ]),
    );
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run db:verify -- signup-invites`
Expected: Every test in `signup-invites.test.ts` PASSES.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/signup-invites.test.ts
git commit -m "$(cat <<'EOF'
Add behavioral test coverage for invite-gated signup

Covers valid redemption, every rejection path (missing/expired/wrong-email/
revoked/already-used code), the no-code profile-only path, the
create_signup_invite RPC, and signup_invites RLS.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Grant-level test coverage

**Files:**
- Modify: `supabase/tests/function-grants.test.ts`

- [ ] **Step 1: Update the grant checks for the invite-gate changes**

In `supabase/tests/function-grants.test.ts`, replace the whole `"RLS-primitive functions: authenticated yes, anon no"` describe block (currently lines 40-62). `create_company_for_current_user` moves out of it — its whole point was "authenticated genuinely needs EXECUTE," which is no longer true after Task 2's revoke — and `create_signup_invite` joins it. `create_company_for_current_user` gets its own describe block instead:

```typescript
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
```

Then update the `"trigger-only functions"` describe block (currently lines 64-80) to add `set_signup_invite_defaults`:

```typescript
describe("trigger-only functions: no one calls these directly", () => {
  const fns = [
    "public.assert_company_matches_vendor()",
    "public.assert_task_company_matches_vendor()",
    "public.handle_new_user()",
    "public.seed_vendor_compliance_items()",
    "public.set_audit_log_actor()",
    "public.assert_company_matches_email_outbox()",
    "public.set_signup_invite_defaults()",
  ];

  it.each(fns)("anon cannot execute %s", async (fn) => {
    expect(await canExecute("anon", fn)).toBe(false);
  });

  it.each(fns)("authenticated cannot execute %s", async (fn) => {
    expect(await canExecute("authenticated", fn)).toBe(false);
  });
```

Leave the rest of that `describe` block (the "triggers still fire" test) unchanged.

- [ ] **Step 2: Run it**

Run: `npm run db:verify -- function-grants`
Expected: All tests PASS, including the new/moved ones.

- [ ] **Step 3: Run the full DB suite once more**

Run: `npm run db:verify`
Expected: Every file in `supabase/tests/` PASSES.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/function-grants.test.ts
git commit -m "$(cat <<'EOF'
Update function-grants coverage for the invite-gate changes

create_company_for_current_user moves out of the "authenticated yes" group
now that its grant is revoked; create_signup_invite joins it (authenticated
yes, anon no); set_signup_invite_defaults joins the trigger-only group.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: TypeScript database types

**Files:**
- Modify: `src/data/db-types.ts`

- [ ] **Step 1: Add the row type**

In `src/data/db-types.ts`, add after `LeadRow` (currently ending at line 240):

```typescript
export type SignupInviteStatus = "pending" | "used" | "revoked";

export interface SignupInviteRow {
  id: string;
  code: string;
  email: string;
  company_name: string;
  status: SignupInviteStatus;
  expires_at: string;
  created_by: string | null;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Register the table and the RPC**

In the `Database.public.Tables` block, add after `leads` (currently line 328):

```typescript
      leads: Table<LeadRow, Pick<LeadRow, "company_name"> & Partial<LeadRow>>;
      signup_invites: Table<
        SignupInviteRow,
        Pick<SignupInviteRow, "email" | "company_name"> & Partial<SignupInviteRow>
      >;
```

In the `Database.public.Functions` block, add after `create_company_for_current_user` (currently lines 335-338):

```typescript
      create_company_for_current_user: {
        Args: { company_name: string; member_name?: string | null };
        Returns: string;
      };
      create_signup_invite: {
        Args: { company_name: string; email: string };
        Returns: SignupInviteRow;
      };
      is_platform_admin: { Args: Record<string, never>; Returns: boolean };
```

- [ ] **Step 3: Commit**

```bash
git add src/data/db-types.ts
git commit -m "$(cat <<'EOF'
Add SignupInviteRow and create_signup_invite to the hand-authored DB types

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Repository contract, demo implementation, and Supabase implementation

**Files:**
- Modify: `src/data/contracts.ts:138-158`
- Modify: `src/data/demoRepository.ts`
- Modify: `src/data/supabaseRepository.ts`

- [ ] **Step 1: Add the domain type and repository methods to the contract**

In `src/data/contracts.ts`, add after the `AccessGrant` interface (currently lines 138-145):

```typescript
export interface SignupInvite {
  id: string;
  companyName: string;
  email: string;
  code: string;
  status: "pending" | "used" | "revoked";
  expiresOn: string;
  createdOn: string;
}

export interface SignupInviteDraft {
  companyName: string;
  email: string;
}
```

Then add to the `DashboardRepository` interface (currently lines 147-158):

```typescript
export interface DashboardRepository {
  listVendors(): Promise<Vendor[]>;
  getVendor(vendorId: string): Promise<Vendor | null>;
  createVendor(draft: VendorDraft): Promise<Vendor>;
  listTasks(): Promise<TaskItem[]>;
  listOverviewMetrics(): Promise<OverviewMetric[]>;
  listReportRows(): Promise<ReportRow[]>;
  listCompanies(): Promise<Company[]>;
  listQueue(): Promise<QueueItem[]>;
  listLeads(): Promise<Lead[]>;
  listAccessGrants(): Promise<AccessGrant[]>;
  listSignupInvites(): Promise<SignupInvite[]>;
  createSignupInvite(draft: SignupInviteDraft): Promise<SignupInvite>;
  revokeSignupInvite(inviteId: string): Promise<void>;
}
```

- [ ] **Step 2: Implement the demo repository**

In `src/data/demoRepository.ts`, add the import for the new types at the top (alongside the existing `AccessGrant` import):

```typescript
import type {
  AccessGrant,
  Company,
  ComplianceItem,
  ComplianceKey,
  ComplianceStatus,
  CoverageLimit,
  DashboardRepository,
  Lead,
  OverviewMetric,
  QueueItem,
  ReportRow,
  SignupInvite,
  SignupInviteDraft,
  TaskItem,
  Vendor,
  VendorDraft,
  VendorTrade,
} from "./contracts";
```

Add the seed data after the `accessGrants` array (currently ending at line 482):

```typescript
const signupInvites: SignupInvite[] = [
  {
    id: "inv-1",
    companyName: "Meridian Fabrication",
    email: "owner@meridianfab.example",
    code: "A1B2C3D4E5",
    status: "pending",
    expiresOn: "2026-09-29",
    createdOn: "2026-09-15",
  },
  {
    id: "inv-2",
    companyName: "Halstead Builders",
    email: "founder@halstead.example",
    code: "F6G7H8I9J0",
    status: "used",
    expiresOn: "2026-09-10",
    createdOn: "2026-08-27",
  },
];
```

Inside `createDemoRepository()`, add a mutable store alongside `vendorStore` (currently line 488):

```typescript
export function createDemoRepository(): DashboardRepository {
  const vendorStore = vendors.map((v) => ({ ...v }));
  const inviteStore = signupInvites.map((i) => ({ ...i }));
```

And add the three methods to the returned object, after `listAccessGrants` (currently line 525):

```typescript
    listAccessGrants: () => delay(accessGrants.map((r) => ({ ...r }))),
    listSignupInvites: () => delay(inviteStore.map((r) => ({ ...r }))),
    createSignupInvite: (draft: SignupInviteDraft) => {
      const invite: SignupInvite = {
        id: `inv-${1400 + inviteStore.length}`,
        companyName: draft.companyName,
        email: draft.email,
        code: Math.random().toString(16).slice(2, 12).toUpperCase(),
        status: "pending",
        expiresOn: "2026-09-29",
        createdOn: "2026-09-15",
      };
      inviteStore.unshift(invite);
      return delay(invite);
    },
    revokeSignupInvite: (inviteId: string) => {
      const invite = inviteStore.find((i) => i.id === inviteId);
      if (invite) invite.status = "revoked";
      return delay(undefined);
    },
```

- [ ] **Step 3: Implement the Supabase repository**

In `src/data/supabaseRepository.ts`, add `SignupInvite` and `SignupInviteDraft` to the `contracts` import (currently lines 1-17), and `SignupInviteRow` to the `db-types` import (currently lines 18-27):

```typescript
import type {
  AccessGrant,
  Company,
  ComplianceItem,
  ComplianceKey,
  ComplianceStatus,
  CoverageLimit,
  DashboardRepository,
  Lead,
  OverviewMetric,
  QueueItem,
  ReportRow,
  SignupInvite,
  SignupInviteDraft,
  TaskItem,
  Vendor,
  VendorDraft,
  VendorTrade,
} from "./contracts";
import type {
  AdminCompanyStatsView,
  CompanyReportRowView,
  CompanyRole,
  ComplianceRequirementRow,
  LeadRow,
  SignupInviteRow,
  VendorComplianceItemRow,
  VendorPolicyRow,
  VendorRow,
} from "./db-types";
```

Add a mapper function after `isoDate` (currently lines 162-164):

```typescript
function toSignupInvite(row: SignupInviteRow): SignupInvite {
  return {
    id: row.id,
    companyName: row.company_name,
    email: row.email,
    code: row.code,
    status: row.status,
    expiresOn: row.expires_at,
    createdOn: row.created_at,
  };
}
```

Add the three methods to the returned object, right after `listAccessGrants` closes. Its final lines currently read:

```typescript
      return members.map((row) => {
        const profile = profileById.get(row.user_id);
        return {
          id: row.id,
          person: profile?.full_name ?? profile?.email ?? "Pending invitation",
          email: profile?.email ?? "",
          role: ROLE_LABELS[row.role],
          scope: row.scope,
          lastActiveOn: row.last_active_at ? row.last_active_at.slice(0, 10) : "Never",
        };
      });
    },
  };
}
```

Insert the three new methods between that closing `},` (end of `listAccessGrants`) and the `};` that closes the returned object:

```typescript
    async listSignupInvites(): Promise<SignupInvite[]> {
      const supabase = clientFactory();
      const rows = unwrap(
        await supabase
          .from("signup_invites")
          .select("*")
          .order("created_at", { ascending: false }),
      ) as SignupInviteRow[];

      return rows.map(toSignupInvite);
    },

    async createSignupInvite(draft: SignupInviteDraft): Promise<SignupInvite> {
      const supabase = clientFactory();
      const row = unwrap(
        await supabase.rpc("create_signup_invite", {
          company_name: draft.companyName,
          email: draft.email,
        }),
      ) as SignupInviteRow;

      return toSignupInvite(row);
    },

    async revokeSignupInvite(inviteId: string): Promise<void> {
      const supabase = clientFactory();
      unwrap(
        await supabase
          .from("signup_invites")
          .update({ status: "revoked" })
          .eq("id", inviteId)
          .select("id")
          .single(),
      );
    },
```

- [ ] **Step 4: Confirm the repository layer type-checks**

Run: `npm run lint`
Expected: No new errors in `src/data/contracts.ts`, `src/data/demoRepository.ts`, or `src/data/supabaseRepository.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/data/contracts.ts src/data/demoRepository.ts src/data/supabaseRepository.ts
git commit -m "$(cat <<'EOF'
Add signup invite methods to the repository contract, demo, and Supabase implementations

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Admin route and nav entry

**Files:**
- Modify: `src/app/router.tsx`
- Create: `src/routes/dashboard.admin.invites.tsx`

- [ ] **Step 1: Add the route path and nav entry**

In `src/app/router.tsx`, update the `routes` object:

```typescript
export const routes = {
  login: "/login",
  signup: "/signup",
  resetPassword: "/reset-password",
  dashboard: "/dashboard",
  vendors: "/dashboard/vendors",
  vendorDetail: "/dashboard/vendors/$vendorId",
  tasks: "/dashboard/tasks",
  reports: "/dashboard/reports",
  settings: "/dashboard/settings",
  adminOverview: "/dashboard/admin",
  adminCompanies: "/dashboard/admin/companies",
  adminCompliance: "/dashboard/admin/compliance",
  adminLeads: "/dashboard/admin/leads",
  adminAccess: "/dashboard/admin/access",
  adminInvites: "/dashboard/admin/invites",
} as const;
```

And update `adminNav`:

```typescript
export const adminNav = [
  { label: "Review queue", to: routes.adminOverview, description: "Priority document decisions" },
  { label: "Companies", to: routes.adminCompanies, description: "Customer accounts" },
  {
    label: "Compliance queue",
    to: routes.adminCompliance,
    description: "Documents awaiting review",
  },
  { label: "Leads", to: routes.adminLeads, description: "Inbound pipeline" },
  { label: "Access", to: routes.adminAccess, description: "Role and scope management" },
  {
    label: "Invites",
    to: routes.adminInvites,
    description: "Codes that gate business signup",
  },
] as const satisfies readonly NavItem[];
```

- [ ] **Step 2: Create the route file**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { InvitesPage } from "@/features/admin/InvitesPage";

export const Route = createFileRoute("/dashboard/admin/invites")({
  head: () => ({
    meta: [
      { title: "Signup invites — VendorClr admin" },
      { name: "description", content: "Admin-issued codes that gate business signup." },
      { property: "og:title", content: "Signup invites — VendorClr admin" },
      { property: "og:description", content: "Codes that gate business signup." },
    ],
  }),
  component: InvitesPage,
});
```

This imports `InvitesPage`, which doesn't exist yet — that's Task 8. The route tree is regenerated and everything is verified together at the end of Task 9.

- [ ] **Step 3: Commit**

```bash
git add src/app/router.tsx src/routes/dashboard.admin.invites.tsx
git commit -m "$(cat <<'EOF'
Add the /dashboard/admin/invites route and nav entry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `InviteForm` and `InvitesPage` components

**Files:**
- Create: `src/features/admin/InviteForm.tsx`
- Create: `src/features/admin/InvitesPage.tsx`

- [ ] **Step 1: Write `InviteForm.tsx`**

Mirrors `src/features/vendors/VendorForm.tsx`'s form/mutation pattern.

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { getRepository } from "@/data/repository";

export function InviteForm({ onDone }: { onDone?: () => void }) {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: repo.createSignupInvite,
    onSuccess: (invite) => {
      void queryClient.invalidateQueries({ queryKey: ["signup-invites"] });
      setNotice(`Invite code ${invite.code} created for ${invite.companyName} (${invite.email}).`);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      companyName: String(form.get("invite-company") ?? "").trim(),
      email: String(form.get("invite-email") ?? "").trim(),
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby="invite-form-heading"
      className="rounded-md border border-border bg-card p-4"
    >
      <h2 id="invite-form-heading" className="text-sm font-semibold text-foreground">
        Create invite
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The code is locked to this email and this company name, and expires in 14 days.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="invite-company" className="block text-sm font-medium">
            Company name
          </label>
          <input
            id="invite-company"
            name="invite-company"
            required
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="invite-email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="invite-email"
            name="invite-email"
            type="email"
            required
            className="focusable mt-1 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {mutation.isPending ? "Creating…" : "Create invite"}
        </button>
        {onDone ? (
          <button
            type="button"
            onClick={onDone}
            className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="mt-3 rounded-sm border border-border bg-muted px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}
      {mutation.isError ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {mutation.error instanceof Error ? mutation.error.message : "Could not create the invite."}
        </p>
      ) : null}
    </form>
  );
}
```

- [ ] **Step 2: Write `InvitesPage.tsx`**

Mirrors `AccessPage.tsx`'s table and `VendorsPage.tsx`'s show/hide form toggle.

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AdminGuard } from "./AdminGuard";
import { InviteForm } from "./InviteForm";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";

export function InvitesPage() {
  const repo = getRepository();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const invites = useQuery({
    queryKey: ["signup-invites"],
    queryFn: () => repo.listSignupInvites(),
  });

  const revoke = useMutation({
    mutationFn: (inviteId: string) => repo.revokeSignupInvite(inviteId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["signup-invites"] });
    },
  });

  return (
    <AppShell
      title="Signup invites"
      subtitle="Admin-issued codes that gate self-serve business signup."
      actions={
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          aria-expanded={showForm}
          className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          {showForm ? "Close invite form" : "Create invite"}
        </button>
      }
    >
      <AdminGuard>
        <div className="space-y-4">
          {showForm ? <InviteForm onDone={() => setShowForm(false)} /> : null}

          {invites.isLoading ? (
            <LoadingState label="Loading signup invites" rows={4} />
          ) : invites.isError ? (
            <ErrorState
              description="Signup invite list failed to load."
              onRetry={() => void invites.refetch()}
            />
          ) : (invites.data ?? []).length === 0 ? (
            <EmptyState
              title="No signup invites"
              description="Create an invite to let a new company sign up."
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full min-w-[720px] text-left text-sm">
                <caption className="sr-only">Signup invites by company</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Company
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Email
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Code
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Expires
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(invites.data ?? []).map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-0">
                      <th scope="row" className="px-3 py-3 font-medium">
                        {invite.companyName}
                      </th>
                      <td className="px-3 py-3 text-xs">{invite.email}</td>
                      <td className="px-3 py-3 text-xs font-mono">{invite.code}</td>
                      <td className="px-3 py-3 text-xs uppercase">{invite.status}</td>
                      <td className="numeric px-3 py-3 text-xs">{invite.expiresOn}</td>
                      <td className="px-3 py-3 text-right text-xs">
                        {invite.status === "pending" ? (
                          <button
                            type="button"
                            onClick={() => revoke.mutate(invite.id)}
                            disabled={revoke.isPending}
                            className="focusable rounded-sm border border-border px-2 py-1 text-xs font-medium disabled:opacity-60"
                          >
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </AdminGuard>
    </AppShell>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/features/admin/InviteForm.tsx src/features/admin/InvitesPage.tsx
git commit -m "$(cat <<'EOF'
Add InviteForm and InvitesPage admin components

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Regenerate the route tree and add frontend test coverage for the admin page

**Files:**
- Regenerate: `src/routeTree.gen.ts` (auto-generated — do not hand-edit)
- Modify: `src/tests/routes.test.tsx:6-21`
- Modify: `src/tests/page-behaviors.test.tsx`

- [ ] **Step 1: Regenerate the route tree**

`src/routeTree.gen.ts` is generated by the TanStack Router Vite plugin (bundled in `@lovable.dev/vite-tanstack-config`), which only runs during `vite dev`/`vite build` — not under Vitest. The new route file from Task 7 won't be registered until a build runs.

Run: `npm run build`
Expected: Build succeeds, and `src/routeTree.gen.ts` is rewritten to include a `DashboardAdminInvitesRouteImport` (or equivalent) for `/dashboard/admin/invites`.

- [ ] **Step 2: Add the route to the expected route list**

In `src/tests/routes.test.tsx`, update `expectedRouteIds`:

```typescript
const expectedRouteIds = [
  "/login",
  "/signup",
  "/reset-password",
  "/dashboard/",
  "/dashboard/vendors/",
  "/dashboard/vendors/$vendorId",
  "/dashboard/tasks",
  "/dashboard/reports",
  "/dashboard/settings",
  "/dashboard/admin/",
  "/dashboard/admin/companies",
  "/dashboard/admin/compliance",
  "/dashboard/admin/leads",
  "/dashboard/admin/access",
  "/dashboard/admin/invites",
] as const;
```

- [ ] **Step 3: Add page-behavior tests for the demo admin experience**

In `src/tests/page-behaviors.test.tsx`, add `"/dashboard/admin/invites"` to the denial-for-customer-role `it.each` table in the `"administrator route behavior"` describe block:

```typescript
  it.each([
    ["/dashboard/admin", "Admin overview"],
    ["/dashboard/admin/companies", "Companies"],
    ["/dashboard/admin/compliance", "Compliance queue"],
    ["/dashboard/admin/leads", "Leads"],
    ["/dashboard/admin/access", "Access management"],
    ["/dashboard/admin/invites", "Signup invites"],
  ])("denies %s for the customer demo role", async (path) => {
```

Then add a dedicated test after the existing `"keeps access invitations demo-only"` test (currently ending at line 165):

```typescript
  it("creates and revokes a signup invite through the demo repository", async () => {
    const { user } = await renderAdminRoute("/dashboard/admin/invites");

    await screen.findByText("Meridian Fabrication");

    await user.click(screen.getByRole("button", { name: /create invite/i }));
    await user.type(screen.getByLabelText("Company name"), "Cedar Ridge Contracting");
    await user.type(screen.getByLabelText("Email"), "owner@cedarridge.example");
    await user.click(screen.getByRole("button", { name: /^create invite$/i }));

    expect(
      await screen.findByText(/invite code .+ created for cedar ridge contracting/i),
    ).toBeInTheDocument();
    expect(await screen.findByText("Cedar Ridge Contracting")).toBeInTheDocument();

    const row = screen.getByText("Cedar Ridge Contracting").closest("tr");
    if (!row) throw new Error("expected a table row for the new invite");
    await user.click(within(row).getByRole("button", { name: /revoke/i }));

    await waitFor(() => expect(within(row).queryByRole("button", { name: /revoke/i })).toBeNull());
    expect(within(row).getByText("revoked")).toBeInTheDocument();
  });
```

This uses `within`, which isn't imported yet — add it to the Testing Library import at the top of the file:

```typescript
import { render, screen, waitFor, within } from "@testing-library/react";
```

- [ ] **Step 4: Run the frontend suite**

Run: `npm test`
Expected: All tests in `src/tests/` PASS, including the new `routes.test.tsx` entry and the two new `page-behaviors.test.tsx` cases.

- [ ] **Step 5: Commit**

```bash
git add src/routeTree.gen.ts src/tests/routes.test.tsx src/tests/page-behaviors.test.tsx
git commit -m "$(cat <<'EOF'
Regenerate the route tree and add frontend coverage for the Invites admin page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update the signup form

**Files:**
- Modify: `src/features/auth/AuthPages.tsx:214-279`

- [ ] **Step 1: Replace the company-name field with an invite-code field and update the metadata payload**

Replace the `SignupPage` component (currently lines 214-279) with:

```tsx
export function SignupPage() {
  const navigate = useNavigate();
  const live = hasBackendEnv();

  const { notice, error, pending, onSubmit } = useAuthForm(async (form) => {
    // The invite code rides along in user metadata. The handle_new_user
    // trigger redeems it against signup_invites and provisions the company
    // (using the invite's own company name, not anything entered here) plus
    // the owner membership - a missing or invalid code fails the whole
    // signUp() call server-side, so this works whether or not email
    // confirmation is enabled.
    const { data, error: signUpError } = await getSupabaseClient().auth.signUp({
      email: text(form, "signup-email"),
      password: String(form.get("signup-password") ?? ""),
      options: {
        data: {
          invite_code: text(form, "invite-code"),
          full_name: text(form, "full-name"),
        },
      },
    });
    if (signUpError) throw new Error(signUpError.message);

    if (data.session) {
      await navigate({ to: "/dashboard" });
      return "Account created.";
    }
    return "Check your email to confirm the account, then sign in.";
  });

  return (
    <AuthLayout
      title="Create an account"
      description="Set up compliance tracking for your subcontractor roster."
      footer={
        <span>
          Already registered?{" "}
          <Link to="/login" className="focusable font-medium text-primary underline">
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <Field
          id="invite-code"
          label="Invite code"
          autoComplete="off"
          required={live}
          hint="Provided by your VendorClr contact."
        />
        <Field id="full-name" label="Your name" autoComplete="name" />
        <Field
          id="signup-email"
          label="Work email"
          type="email"
          autoComplete="email"
          required={live}
          hint="Must match the email the invite was sent to."
        />
        <Field
          id="signup-password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required={live}
          hint="Minimum 12 characters."
        />
        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "Creating…" : live ? "Create account" : "Create account (demo)"}
        </button>
        <Messages notice={notice} error={error} />
      </form>
    </AuthLayout>
  );
}
```

Note `Field`'s `id` prop doubles as its form field `name` (see `Field`'s definition, lines 15-51: `<input id={id} name={id} ... />`), so `id="invite-code"` is what `text(form, "invite-code")` reads above.

- [ ] **Step 2: Commit**

```bash
git add src/features/auth/AuthPages.tsx
git commit -m "$(cat <<'EOF'
Replace the signup form's company-name field with an invite-code field

Company name is no longer client-supplied - it comes from the redeemed
invite server-side, so a code can't be used to claim a different company
than the admin intended.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Frontend test coverage for the updated signup form

**Files:**
- Modify: `src/tests/page-behaviors.test.tsx`

- [ ] **Step 1: Add a test asserting the new field is present and the company-name field is gone**

In `src/tests/page-behaviors.test.tsx`, add a new test to the `"authenticated-demo route behavior"` describe block, right after the existing `it.each` block for `/login`/`/signup`/`/reset-password` (currently ending at line 37):

```typescript
  it("asks for an invite code on signup instead of a free-text company name", async () => {
    await renderRoute("/signup");

    expect(await screen.findByLabelText("Invite code")).toBeInTheDocument();
    expect(screen.queryByLabelText("Company name")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the frontend suite**

Run: `npm test`
Expected: All tests in `src/tests/` PASS, including the new signup-form test.

- [ ] **Step 3: Commit**

```bash
git add src/tests/page-behaviors.test.tsx
git commit -m "$(cat <<'EOF'
Add frontend test coverage for the invite-code signup field

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 2: Run the full DB verification suite**

Run: `npm run db:verify`
Expected: All tests PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Build succeeds (this also confirms `src/routeTree.gen.ts` is up to date with no further changes — if `git status` shows it modified after this build, stage and include it in this task's commit).

- [ ] **Step 5: Manually smoke-test the demo dashboard**

Run: `npm run dev`, then in a browser:
1. Open `/dashboard/admin/invites` with the demo role switched to Administrator — confirm the seeded invites (Meridian Fabrication: pending, Halstead Builders: used) render, "Create invite" opens the form, submitting it adds a row and shows the generated code in the notice, and "Revoke" flips a pending row to `revoked` and hides its Revoke button.
2. Open `/signup` — confirm the form shows "Invite code" (not "Company name"), and submitting shows the existing demo-mode notice ("nothing was submitted, saved or emailed").

Expected: Both flows behave as described, matching the approved design.

- [ ] **Step 6: Commit any residual changes**

```bash
git status
```

If `src/routeTree.gen.ts` or anything else changed from Step 4 and isn't already committed:

```bash
git add -A
git commit -m "$(cat <<'EOF'
Sync generated route tree after final build verification

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

If nothing changed, no commit is needed — the feature is complete.
