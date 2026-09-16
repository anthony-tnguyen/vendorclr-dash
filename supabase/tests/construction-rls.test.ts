import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * RLS and cross-tenant integrity for the construction core (migration 20):
 * projects, project_vendor_assignments, requirement_profiles,
 * requirement_profile_rules, project_requirement_overrides.
 *
 * Two boundaries matter here, same as compliance-requirements.test.ts and
 * schema.test.ts's vendor domain block:
 *
 *   - Role-aware RLS: owners/risk managers configure requirements; project
 *     engineers additionally mutate assignments/projects; read_only never
 *     writes anything.
 *   - Cross-company integrity triggers: a member who can write to their own
 *     company must not be able to attach a row to another company's project,
 *     vendor or requirement profile just by naming its id - the FK and the
 *     WITH CHECK policy would each pass that individually.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const RISK_MANAGER = "22222222-2222-2222-2222-222222222222";
const PROJECT_ENGINEER = "33333333-3333-3333-3333-333333333333";
const READER = "44444444-4444-4444-4444-444444444444";
const RIVAL_OWNER = "55555555-5555-5555-5555-555555555555";

let db: PGlite;
let companyId: string;
let rivalCompanyId: string;
let rivalProjectId: string;
let rivalVendorId: string;
let rivalProfileId: string;

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);

  await signUp(db, { id: RISK_MANAGER, email: "risk@halstead.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'risk_manager')`,
    [companyId, RISK_MANAGER],
  );

  await signUp(db, { id: PROJECT_ENGINEER, email: "engineer@halstead.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'project_engineer')`,
    [companyId, PROJECT_ENGINEER],
  );

  await signUp(db, { id: READER, email: "reader@halstead.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only')`,
    [companyId, READER],
  );

  await signUp(db, {
    id: RIVAL_OWNER,
    email: "owner@rival.test",
    companyName: "Rival Construction",
  });
  rivalCompanyId = await companyIdFor(db, RIVAL_OWNER);

  const rivalProject = await db.query<{ id: string }>(
    `insert into public.projects (company_id, name) values ($1, 'Rival Site') returning id`,
    [rivalCompanyId],
  );
  rivalProjectId = rivalProject.rows[0]!.id;

  const rivalVendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Rival Sub', 'Roofing') returning id`,
    [rivalCompanyId],
  );
  rivalVendorId = rivalVendor.rows[0]!.id;

  const rivalProfile = await db.query<{ id: string }>(
    `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
    [rivalCompanyId],
  );
  rivalProfileId = rivalProfile.rows[0]!.id;
}, 60_000);

describe("requirement_profiles: owner/risk_manager write, everyone else read-only", () => {
  it("lets an owner create a profile", async () => {
    const rows = await asUser<{ name: string }>(
      db,
      OWNER,
      `insert into public.requirement_profiles (company_id, name) values ($1, 'Owner Profile') returning name`,
      [companyId],
    );
    expect(rows[0]?.name).toBe("Owner Profile");
  });

  it("lets a risk_manager create a profile", async () => {
    const rows = await asUser<{ name: string }>(
      db,
      RISK_MANAGER,
      `insert into public.requirement_profiles (company_id, name) values ($1, 'Risk Manager Profile') returning name`,
      [companyId],
    );
    expect(rows[0]?.name).toBe("Risk Manager Profile");
  });

  it("refuses a project_engineer creating a profile", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        PROJECT_ENGINEER,
        `insert into public.requirement_profiles (company_id, name) values ($1, 'Engineer Attempt')`,
        [companyId],
      ),
    );
  });

  it("refuses a read_only member creating a profile", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `insert into public.requirement_profiles (company_id, name) values ($1, 'Reader Attempt')`,
        [companyId],
      ),
    );
  });

  it("is invisible to a rival company", async () => {
    const rows = await asUser<{ n: number }>(
      db,
      RIVAL_OWNER,
      `select count(*)::int n from public.requirement_profiles where company_id = $1`,
      [companyId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("requirement_profile_rules: owner/risk_manager write only", () => {
  let profileId: string;

  beforeAll(async () => {
    const rows = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );
    profileId = rows.rows[0]!.id;
  });

  it("lets a risk_manager add a rule", async () => {
    const rows = await asUser<{ rule_key: string }>(
      db,
      RISK_MANAGER,
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, rule_kind, required)
       values ($1, $2, 'lien_waiver', 'document', true)
       returning rule_key`,
      [companyId, profileId],
    );
    expect(rows[0]?.rule_key).toBe("lien_waiver");
  });

  it("refuses a project_engineer adding a rule", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        PROJECT_ENGINEER,
        `insert into public.requirement_profile_rules
           (company_id, profile_id, rule_key, rule_kind, required)
         values ($1, $2, 'engineer_attempt', 'document', true)`,
        [companyId, profileId],
      ),
    );
  });

  it("rejects a rule_kind outside the allowed set", async () => {
    await expect(
      db.query(
        `insert into public.requirement_profile_rules
           (company_id, profile_id, rule_key, rule_kind, required)
         values ($1, $2, 'bad_kind', 'not_a_real_kind', true)`,
        [companyId, profileId],
      ),
    ).rejects.toThrow();
  });
});

describe("project_requirement_overrides: owner/risk_manager write only", () => {
  let projectId: string;

  beforeAll(async () => {
    const rows = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Override Site') returning id`,
      [companyId],
    );
    projectId = rows.rows[0]!.id;
  });

  it("lets an owner add an override", async () => {
    const rows = await asUser<{ rule_key: string }>(
      db,
      OWNER,
      `insert into public.project_requirement_overrides (company_id, project_id, rule_key, value)
       values ($1, $2, 'lien_waiver', '{"required": false}'::jsonb)
       returning rule_key`,
      [companyId, projectId],
    );
    expect(rows[0]?.rule_key).toBe("lien_waiver");
  });

  it("refuses a project_engineer adding an override - narrower than project_vendor_assignments' broader write access", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        PROJECT_ENGINEER,
        `insert into public.project_requirement_overrides (company_id, project_id, rule_key, value)
         values ($1, $2, 'engineer_attempt', '{"required": false}'::jsonb)`,
        [companyId, projectId],
      ),
    );
  });

  it("refuses a read_only member adding an override", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `insert into public.project_requirement_overrides (company_id, project_id, rule_key, value)
         values ($1, $2, 'reader_attempt', '{"required": false}'::jsonb)`,
        [companyId, projectId],
      ),
    );
  });
});

describe("projects and project_vendor_assignments: owner/risk_manager/project_engineer write", () => {
  it("lets a project_engineer create a project", async () => {
    const rows = await asUser<{ name: string }>(
      db,
      PROJECT_ENGINEER,
      `insert into public.projects (company_id, name) values ($1, 'Engineer Site') returning name`,
      [companyId],
    );
    expect(rows[0]?.name).toBe("Engineer Site");
  });

  it("refuses a read_only member creating a project", async () => {
    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `insert into public.projects (company_id, name) values ($1, 'Reader Site')`,
        [companyId],
      ),
    );
  });

  it("lets a project_engineer create an assignment", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Assignment Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Assignment Vendor', 'Concrete') returning id`,
      [companyId],
    );

    const rows = await asUser<{ id: string }>(
      db,
      PROJECT_ENGINEER,
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );
    expect(rows[0]?.id).toBeTruthy();
  });

  it("refuses a read_only member creating an assignment", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Reader Assignment Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Reader Assignment Vendor', 'Concrete') returning id`,
      [companyId],
    );

    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `insert into public.project_vendor_assignments (company_id, project_id, vendor_id) values ($1, $2, $3)`,
        [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
      ),
    );
  });

  it("restricts assignment delete to owner/risk_manager", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Delete Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Delete Vendor', 'Concrete') returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    // RLS denial on DELETE is silent, not an error: a USING clause that
    // matches nothing just deletes zero rows (see harness.ts's docblock on
    // why this suite runs through real RLS instead of assuming policies
    // work). Assert the row survives, not that the statement throws.
    const deniedAttempt = await asUser<{ id: string }>(
      db,
      PROJECT_ENGINEER,
      `delete from public.project_vendor_assignments where id = $1 returning id`,
      [assignment.rows[0]!.id],
    );
    expect(deniedAttempt).toEqual([]);

    const stillThere = await db.query<{ n: number }>(
      `select count(*)::int n from public.project_vendor_assignments where id = $1`,
      [assignment.rows[0]!.id],
    );
    expect(stillThere.rows[0]?.n).toBe(1);

    const rows = await asUser<{ id: string }>(
      db,
      OWNER,
      `delete from public.project_vendor_assignments where id = $1 returning id`,
      [assignment.rows[0]!.id],
    );
    expect(rows[0]?.id).toBe(assignment.rows[0]!.id);
  });

  it("restricts project delete to owner/risk_manager - asymmetric with insert/update's broader can_write_company()", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Project Delete Site') returning id`,
      [companyId],
    );

    // Same silent-denial shape as the assignment-delete test above: a
    // USING clause matching nothing deletes zero rows, not an error.
    const deniedAttempt = await asUser<{ id: string }>(
      db,
      PROJECT_ENGINEER,
      `delete from public.projects where id = $1 returning id`,
      [project.rows[0]!.id],
    );
    expect(deniedAttempt).toEqual([]);

    const stillThere = await db.query<{ n: number }>(
      `select count(*)::int n from public.projects where id = $1`,
      [project.rows[0]!.id],
    );
    expect(stillThere.rows[0]?.n).toBe(1);

    const rows = await asUser<{ id: string }>(
      db,
      OWNER,
      `delete from public.projects where id = $1 returning id`,
      [project.rows[0]!.id],
    );
    expect(rows[0]?.id).toBe(project.rows[0]!.id);
  });
});

describe("cross-tenant integrity triggers", () => {
  it("refuses an assignment whose project belongs to another company", async () => {
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Own Vendor', 'Concrete') returning id`,
      [companyId],
    );

    // company_id names Halstead; project_id points at Rival's project. The FK
    // and the WITH CHECK on company_id both pass this individually - only the
    // trigger catches it.
    await expect(
      asUser(
        db,
        OWNER,
        `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
         values ($1, $2, $3)`,
        [companyId, rivalProjectId, vendor.rows[0]!.id],
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses an assignment whose vendor belongs to another company", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Own Project') returning id`,
      [companyId],
    );

    await expect(
      asUser(
        db,
        OWNER,
        `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
         values ($1, $2, $3)`,
        [companyId, project.rows[0]!.id, rivalVendorId],
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses an assignment whose requirement_profile_id belongs to another company", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Profile Cross Project') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Profile Cross Vendor', 'Concrete') returning id`,
      [companyId],
    );

    await expect(
      asUser(
        db,
        OWNER,
        `insert into public.project_vendor_assignments (company_id, project_id, vendor_id, requirement_profile_id)
         values ($1, $2, $3, $4)`,
        [companyId, project.rows[0]!.id, vendor.rows[0]!.id, rivalProfileId],
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses a project whose default_requirement_profile_id belongs to another company", async () => {
    await expect(
      asUser(
        db,
        OWNER,
        `insert into public.projects (company_id, name, default_requirement_profile_id) values ($1, 'Bad Default', $2)`,
        [companyId, rivalProfileId],
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses a requirement_profile_rules row whose profile belongs to another company", async () => {
    await expect(
      asUser(
        db,
        OWNER,
        `insert into public.requirement_profile_rules (company_id, profile_id, rule_key, rule_kind, required)
         values ($1, $2, 'cross_company_rule', 'document', true)`,
        [companyId, rivalProfileId],
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses a project_requirement_overrides row whose project belongs to another company", async () => {
    await expect(
      asUser(
        db,
        OWNER,
        `insert into public.project_requirement_overrides (company_id, project_id, rule_key, value)
         values ($1, $2, 'cross_company_override', '{}'::jsonb)`,
        [companyId, rivalProjectId],
      ),
    ).rejects.toThrow(/does not match/);
  });

  it("is invisible to a rival company across every new table", async () => {
    const tables = [
      "projects",
      "project_vendor_assignments",
      "requirement_profiles",
      "requirement_profile_rules",
      "project_requirement_overrides",
    ];

    for (const table of tables) {
      const rows = await asUser<{ n: number }>(
        db,
        RIVAL_OWNER,
        `select count(*)::int n from public.${table} where company_id = $1`,
        [companyId],
      );
      expect(rows[0]?.n, `${table} leaked a Halstead row to Rival`).toBe(0);
    }
  });
});

describe("resolve_assignment_requirements(): cross-tenant IDOR", () => {
  // SECURITY DEFINER functions do not inherit RLS just because the tables
  // they read have RLS enabled - the function runs as its owning role, which
  // bypasses RLS entirely. Without an explicit authorization check as the
  // function's first statement, a member of one company could call this RPC
  // with another company's assignment id and read that company's resolved
  // requirements (policy types, amounts, rule keys). This is exactly the gap
  // a spec review found live against the hosted project - covering it here so
  // a regression fails a fast local test, not another live audit.
  it("refuses to resolve an assignment belonging to a different company", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Rival Only Site') returning id`,
      [rivalCompanyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [rivalCompanyId, project.rows[0]!.id, rivalVendorId],
    );

    await expect(
      asUser(db, OWNER, `select * from public.resolve_assignment_requirements($1)`, [
        assignment.rows[0]!.id,
      ]),
    ).rejects.toThrow(/not authorized/);
  });

  it("gives the exact same error for a nonexistent assignment id, so the message cannot be used to probe real ids", async () => {
    const bogus = "00000000-0000-0000-0000-000000000000";

    await expect(
      asUser(db, OWNER, `select * from public.resolve_assignment_requirements($1)`, [bogus]),
    ).rejects.toThrow(/not authorized/);
  });

  it("still lets a member resolve their own company's assignment", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Own Resolve Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Own Resolve Vendor', 'Concrete') returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    // Not asserting the exact rows here - earlier tests in this file already
    // added rules to the company default profile, and this assertion should
    // not be coupled to that unrelated state. The point of this test is only
    // that a member resolving their OWN company's assignment is not rejected
    // by the authorization check added above.
    const rows = await asUser(
      db,
      OWNER,
      `select * from public.resolve_assignment_requirements($1)`,
      [assignment.rows[0]!.id],
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("requirement_profiles: the last company-default profile cannot be removed", () => {
  // RLS alone allows an owner/risk_manager to delete or demote the one
  // is_company_default = true row for their own company - that write is
  // entirely within their own tenant, so no cross-tenant policy stops it.
  // Without a guard, resolve_assignment_requirements() would then silently
  // resolve to zero required rules for every assignment that falls back to
  // the company default - the worst failure mode a compliance product can
  // have. requirement_profiles_require_default_after_update/_after_delete
  // (the expand migration) are what prevent that state from ever existing.
  //
  // This is a statement-level (FOR EACH STATEMENT with a transition table),
  // not row-level, trigger - deliberately, so that an atomic single-statement
  // swap (promote the new default, demote the old one, in one UPDATE) is
  // still allowed even though a bare demote-with-nothing-promoted is not. A
  // row-level BEFORE trigger cannot tell those two apart, because it
  // evaluates each row in isolation mid-statement with no visibility into a
  // sibling row changing in the same statement - see the swap test below.
  it("refuses to delete the company default profile", async () => {
    const defaultProfile = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );

    await expect(
      asUser(db, OWNER, `delete from public.requirement_profiles where id = $1`, [
        defaultProfile.rows[0]!.id,
      ]),
    ).rejects.toThrow(/must always have exactly one default/);
  });

  it("refuses to demote the company default profile to non-default", async () => {
    const defaultProfile = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );

    await expect(
      asUser(
        db,
        OWNER,
        `update public.requirement_profiles set is_company_default = false where id = $1`,
        [defaultProfile.rows[0]!.id],
      ),
    ).rejects.toThrow(/must always have exactly one default/);
  });

  it("still allows ordinary updates to the default profile that do not touch is_company_default", async () => {
    const defaultProfile = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );

    const rows = await asUser<{ name: string }>(
      db,
      OWNER,
      `update public.requirement_profiles set name = 'Renamed Default' where id = $1 returning name`,
      [defaultProfile.rows[0]!.id],
    );
    expect(rows[0]?.name).toBe("Renamed Default");
  });

  it("allows an atomic single-statement swap of the default to a different profile", async () => {
    const oldDefault = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );
    const newDefault = await db.query<{ id: string }>(
      `insert into public.requirement_profiles (company_id, name) values ($1, 'Swap Target') returning id`,
      [companyId],
    );

    // One statement, touching both rows: promotes newDefault and demotes
    // oldDefault together. Neither row is ever the sole default mid-statement
    // in a way any BEFORE ROW trigger could observe - only the net result
    // (still exactly one default) is checked, after the fact.
    const rows = await asUser<{ id: string; is_company_default: boolean }>(
      db,
      OWNER,
      `update public.requirement_profiles
       set is_company_default = (id = $2)
       where company_id = $1 and id in ($3, $2)
       returning id, is_company_default`,
      [companyId, newDefault.rows[0]!.id, oldDefault.rows[0]!.id],
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        { id: newDefault.rows[0]!.id, is_company_default: true },
        { id: oldDefault.rows[0]!.id, is_company_default: false },
      ]),
    );

    const check = await db.query<{ n: number }>(
      `select count(*)::int n from public.requirement_profiles
       where company_id = $1 and is_company_default`,
      [companyId],
    );
    expect(check.rows[0]?.n).toBe(1);

    // Restore state for any later test in this file that assumes the
    // original default profile.
    await db.query(
      `update public.requirement_profiles set is_company_default = (id = $2)
       where company_id = $1 and id in ($3, $2)`,
      [companyId, oldDefault.rows[0]!.id, newDefault.rows[0]!.id],
    );
  });

  it("still refuses a bare demote in the same swap shape when nothing is promoted to replace it", async () => {
    const defaultProfile = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );

    // Same statement shape as the successful swap above, but the "promote"
    // side names a row that will never actually become true (a nonexistent
    // id) - net effect after the statement is zero defaults, which must
    // still be rejected.
    const bogus = "00000000-0000-0000-0000-000000000000";
    await expect(
      asUser(
        db,
        OWNER,
        `update public.requirement_profiles
         set is_company_default = (id = $2)
         where company_id = $1 and id = $3`,
        [companyId, bogus, defaultProfile.rows[0]!.id],
      ),
    ).rejects.toThrow(/must always have exactly one default/);
  });
});
