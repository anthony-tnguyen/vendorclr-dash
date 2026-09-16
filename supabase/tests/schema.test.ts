import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { companyIdFor, createTestDb, migrationFiles, signUp } from "./harness";

const OWNER = "11111111-1111-1111-1111-111111111111";

let db: PGlite;
let companyId: string;

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);
}, 60_000);

describe("migrations", () => {
  it("finds every migration file", () => {
    // createTestDb() already applied them; a failure there fails this whole file.
    expect(migrationFiles().length).toBeGreaterThanOrEqual(3);
  });

  it("creates every expected table", async () => {
    const result = await db.query<{ table_name: string }>(`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `);
    const names = result.rows.map((r) => r.table_name).sort();

    expect(names).toEqual([
      "audit_log",
      "companies",
      "company_feature_flags",
      "company_invitations",
      "company_members",
      "compliance_queue_items",
      "compliance_requirements",
      "contacts",
      "email_delivery_events",
      "email_outbox",
      "leads",
      "platform_admins",
      "policy_reminder_log",
      "profiles",
      "project_requirement_overrides",
      "project_vendor_assignments",
      "projects",
      "requirement_profile_rules",
      "requirement_profiles",
      "signup_invites",
      "suppressed_recipients",
      "tasks",
      "upload_rate_limit_counters",
      "vendor_compliance_items",
      "vendor_contacts",
      "vendor_documents",
      "vendor_policies",
      "vendor_upload_requests",
      "vendors",
    ]);
  });

  it("enables row level security on every public table", async () => {
    const result = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and rowsecurity = false`,
    );
    expect(result.rows.map((r) => r.tablename)).toEqual([]);
  });

  it("declares every view security_invoker so views cannot bypass RLS", async () => {
    const result = await db.query<{ relname: string; reloptions: string[] | null }>(`
      select c.relname, c.reloptions from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
    `);

    expect(result.rows.length).toBe(5);
    for (const view of result.rows) {
      expect(view.reloptions ?? [], `${view.relname} must be security_invoker`).toContain(
        "security_invoker=true",
      );
    }
  });
});

describe("signup provisioning", () => {
  it("creates a profile, a company and an owner membership from signup metadata", async () => {
    const profiles = await db.query<{ email: string }>(`select email from public.profiles`);
    expect(profiles.rows).toEqual([{ email: "owner@halstead.test" }]);

    const membership = await db.query<{ name: string; role: string }>(`
      select c.name, m.role from public.company_members m
      join public.companies c on c.id = m.company_id
    `);
    expect(membership.rows).toEqual([{ name: "Halstead Builders", role: "owner" }]);
  });

  it("creates no company when signup supplied no company name", async () => {
    const solo = "99999999-9999-9999-9999-999999999999";
    await signUp(db, { id: solo, email: "invitee@halstead.test" });

    const result = await db.query<{ n: number }>(
      `select count(*)::int n from public.company_members where user_id = $1`,
      [solo],
    );
    expect(result.rows[0]?.n).toBe(0);
  });
});

describe("vendor domain constraints", () => {
  it("seeds a new vendor with all five requirements missing", async () => {
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Fresh Sub', 'Roofing')
       returning id`,
      [companyId],
    );

    const items = await db.query<{ status: string; n: number }>(
      `select status, count(*)::int n from public.vendor_compliance_items
       where vendor_id = $1 group by status`,
      [vendor.rows[0]!.id],
    );

    // A vendor existing is never, by itself, evidence of compliance.
    expect(items.rows).toEqual([{ status: "missing", n: 5 }]);
  });

  it("rejects a trade outside the allowed set", async () => {
    await expect(
      db.query(
        `insert into public.vendors (company_id, name, trade) values ($1, 'X', 'Basketweaving')`,
        [companyId],
      ),
    ).rejects.toThrow();
  });

  it("allows one vendor to hold several different coverage types", async () => {
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Multi Cover', 'Electrical')
       returning id`,
      [companyId],
    );
    const vendorId = vendor.rows[0]!.id;

    await db.query(
      `insert into public.vendor_policies (company_id, vendor_id, policy_type, carrier_name)
       values ($1,$2,'general_liability','Travelers'),
              ($1,$2,'workers_compensation','Hartford'),
              ($1,$2,'umbrella','Travelers')`,
      [companyId, vendorId],
    );

    const result = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_policies where vendor_id = $1`,
      [vendorId],
    );
    // The case the old flat policyNumber/expiresOn pair could not represent.
    expect(result.rows[0]?.n).toBe(3);
  });

  it("permits only one active policy per vendor per coverage type", async () => {
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Dup Policy', 'Concrete')
       returning id`,
      [companyId],
    );
    const vendorId = vendor.rows[0]!.id;

    await db.query(
      `insert into public.vendor_policies (company_id, vendor_id, policy_type) values ($1,$2,'general_liability')`,
      [companyId, vendorId],
    );

    await expect(
      db.query(
        `insert into public.vendor_policies (company_id, vendor_id, policy_type) values ($1,$2,'general_liability')`,
        [companyId, vendorId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a child row whose company_id does not match its vendor", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    await signUp(db, { id: other, email: "rival@rival.test", companyName: "Rival Construction" });
    const otherCompany = await companyIdFor(db, other);

    const rivalVendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Rival Sub', 'Glazing')
       returning id`,
      [otherCompany],
    );

    // The FK and the INSERT policy both accept this. Only the trigger catches it.
    await expect(
      db.query(
        `insert into public.vendor_policies (company_id, vendor_id, policy_type) values ($1,$2,'general_liability')`,
        [companyId, rivalVendor.rows[0]!.id],
      ),
    ).rejects.toThrow(/does not match/);
  });
});

describe("aggregate views", () => {
  it("counts requirements once per vendor regardless of policy count", async () => {
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade, project)
       values ($1, 'Fanout Check', 'Earthwork', 'Fanout Project') returning id`,
      [companyId],
    );
    const vendorId = vendor.rows[0]!.id;

    await db.query(
      `insert into public.vendor_policies (company_id, vendor_id, policy_type)
       values ($1,$2,'general_liability'), ($1,$2,'umbrella'), ($1,$2,'commercial_auto')`,
      [companyId, vendorId],
    );

    const result = await db.query<{ open_exceptions: number; fully_compliant: boolean }>(
      `select open_exceptions, fully_compliant from public.vendor_compliance_summary
       where vendor_id = $1`,
      [vendorId],
    );

    // Regression: joining compliance items and policies to vendors produced a
    // cartesian product, and this reported 15 (5 requirements x 3 policies).
    expect(result.rows[0]?.open_exceptions).toBe(5);
    expect(result.rows[0]?.fully_compliant).toBe(false);
  });

  it("treats a vendor with no requirements on file as not compliant", async () => {
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'No Reqs', 'Glazing')
       returning id`,
      [companyId],
    );
    const vendorId = vendor.rows[0]!.id;
    await db.query(`delete from public.vendor_compliance_items where vendor_id = $1`, [vendorId]);

    const result = await db.query<{ fully_compliant: boolean }>(
      `select fully_compliant from public.vendor_compliance_summary where vendor_id = $1`,
      [vendorId],
    );

    // bool_and over zero rows is NULL; collapsing that to true would silently
    // mark every empty vendor compliant.
    expect(result.rows[0]?.fully_compliant).toBe(false);
  });
});
