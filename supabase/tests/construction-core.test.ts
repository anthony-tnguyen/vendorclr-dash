import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

/**
 * resolve_assignment_requirements() (migration 20) - the effective-requirements
 * precedence at the heart of Task 4:
 *
 *   1. Company default profile.
 *   2. Project's own default profile, if set.
 *   3. Assignment's own profile pick, if set.
 *   4. Project-level overrides, applied last, matched by rule_key.
 *
 * Each step above wins outright over the ones before it (whole-profile
 * selection, not a per-rule merge), and step 4 overlays on top of whichever
 * profile won. This is the highest-value logic in the whole migration to
 * cover thoroughly - see the function's own docblock in the expand migration.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";

let db: PGlite;
let companyId: string;

interface ResolvedRow {
  key: string;
  policy_type: string | null;
  kind: string;
  required: boolean;
  amount: number | null;
  source: string;
  configuration: Record<string, unknown>;
}

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);
}, 60_000);

async function resolve(assignmentId: string): Promise<ResolvedRow[]> {
  const rows = await asUser<ResolvedRow>(
    db,
    OWNER,
    `select * from public.resolve_assignment_requirements($1) order by key`,
    [assignmentId],
  );
  return rows;
}

describe("resolve_assignment_requirements()", () => {
  it("falls back to the company default profile when nothing else is picked", async () => {
    // The signup trigger already seeded exactly one is_company_default = true
    // profile for this company - that invariant is what this whole test
    // suite leans on.
    const defaultProfile = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );
    const profileId = defaultProfile.rows[0]!.id;

    await db.query(
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount)
       values ($1, $2, 'gl_each_occ', 'general_liability', 'limit', true, 2000000)`,
      [companyId, profileId],
    );

    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Harbor Point Tower B') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Steel', 'Structural Steel')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    const rows = await resolve(assignment.rows[0]!.id);
    expect(rows).toEqual([
      {
        key: "gl_each_occ",
        policy_type: "general_liability",
        kind: "limit",
        required: true,
        amount: 2000000,
        source: "company_profile",
        configuration: {},
      },
    ]);
  });

  it("returns configuration alongside the rest of a resolved requirement, round-tripping a limitField (Task 9b)", async () => {
    const defaultProfile = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );
    const profileId = defaultProfile.rows[0]!.id;

    await db.query(
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount, configuration)
       values ($1, $2, 'gl_agg', 'general_liability', 'limit', true, 4000000,
               '{"limitField": "general_aggregate"}'::jsonb)`,
      [companyId, profileId],
    );

    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Configuration Round Trip Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Config Vendor', 'Roofing')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    const rows = await resolve(assignment.rows[0]!.id);
    const rule = rows.find((r) => r.key === "gl_agg");
    expect(rule).toEqual(
      expect.objectContaining({
        amount: 4000000,
        configuration: { limitField: "general_aggregate" },
      }),
    );
  });

  it("carries a project override's own configuration onto a pure-override (extra) requirement", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Override Configuration Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Override Config Vendor', 'Glazing')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    await db.query(
      `insert into public.project_requirement_overrides (company_id, project_id, rule_key, value)
       values ($1, $2, 'site_ai_endorsement',
               '{"kind": "endorsement", "policyType": "general_liability", "required": true,
                 "configuration": {"endorsementField": "additional_insured"}}'::jsonb)`,
      [companyId, project.rows[0]!.id],
    );

    const rows = await resolve(assignment.rows[0]!.id);
    const extra = rows.find((r) => r.key === "site_ai_endorsement");
    expect(extra).toEqual(
      expect.objectContaining({
        kind: "endorsement",
        configuration: { endorsementField: "additional_insured" },
      }),
    );
  });

  it("prefers the project's own default profile over the company default", async () => {
    const projectProfile = await db.query<{ id: string }>(
      `insert into public.requirement_profiles (company_id, name) values ($1, 'High Rise Standard') returning id`,
      [companyId],
    );
    await db.query(
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount)
       values ($1, $2, 'gl_each_occ', 'general_liability', 'limit', true, 5000000)`,
      [companyId, projectProfile.rows[0]!.id],
    );

    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name, default_requirement_profile_id)
       values ($1, 'Riverside Campus', $2) returning id`,
      [companyId, projectProfile.rows[0]!.id],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Riverside Electric', 'Electrical')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    const rows = await resolve(assignment.rows[0]!.id);
    expect(rows).toEqual([expect.objectContaining({ amount: 5000000, source: "project_profile" })]);
  });

  it("prefers the assignment's own profile pick over the project's default", async () => {
    const projectProfile = await db.query<{ id: string }>(
      `insert into public.requirement_profiles (company_id, name) values ($1, 'Project Default 2') returning id`,
      [companyId],
    );
    await db.query(
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount)
       values ($1, $2, 'gl_each_occ', 'general_liability', 'limit', true, 3000000)`,
      [companyId, projectProfile.rows[0]!.id],
    );

    const assignmentProfile = await db.query<{ id: string }>(
      `insert into public.requirement_profiles (company_id, name) values ($1, 'High Risk Trade') returning id`,
      [companyId],
    );
    await db.query(
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount)
       values ($1, $2, 'gl_each_occ', 'general_liability', 'limit', true, 10000000)`,
      [companyId, assignmentProfile.rows[0]!.id],
    );

    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name, default_requirement_profile_id)
       values ($1, 'Crane Alley', $2) returning id`,
      [companyId, projectProfile.rows[0]!.id],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Crane Ops', 'Earthwork')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id, requirement_profile_id)
       values ($1, $2, $3, $4) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id, assignmentProfile.rows[0]!.id],
    );

    const rows = await resolve(assignment.rows[0]!.id);
    expect(rows).toEqual([
      expect.objectContaining({ amount: 10000000, source: "assignment_profile" }),
    ]);
  });

  it("applies a project override on top of the winning profile, for an existing rule", async () => {
    const defaultProfile = await db.query<{ id: string }>(
      `select id from public.requirement_profiles where company_id = $1 and is_company_default`,
      [companyId],
    );
    await db.query(
      `insert into public.requirement_profile_rules
         (company_id, profile_id, rule_key, policy_type, rule_kind, required, amount)
       values ($1, $2, 'wc_limit', 'workers_compensation', 'limit', true, 1000000)
       on conflict (profile_id, rule_key) do nothing`,
      [companyId, defaultProfile.rows[0]!.id],
    );

    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Override Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Override Vendor', 'Roofing')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    await db.query(
      `insert into public.project_requirement_overrides (company_id, project_id, rule_key, value)
       values ($1, $2, 'wc_limit', '{"amount": 2000000}'::jsonb)`,
      [companyId, project.rows[0]!.id],
    );

    const rows = await resolve(assignment.rows[0]!.id);
    const wc = rows.find((r) => r.key === "wc_limit");
    expect(wc).toEqual(
      expect.objectContaining({
        amount: 2000000,
        required: true,
        policy_type: "workers_compensation",
        source: "project_override",
      }),
    );
  });

  it("folds in a project override that names a rule_key no profile defines", async () => {
    const project = await db.query<{ id: string }>(
      `insert into public.projects (company_id, name) values ($1, 'Extra Rule Site') returning id`,
      [companyId],
    );
    const vendor = await db.query<{ id: string }>(
      `insert into public.vendors (company_id, name, trade) values ($1, 'Extra Vendor', 'Glazing')
       returning id`,
      [companyId],
    );
    const assignment = await db.query<{ id: string }>(
      `insert into public.project_vendor_assignments (company_id, project_id, vendor_id)
       values ($1, $2, $3) returning id`,
      [companyId, project.rows[0]!.id, vendor.rows[0]!.id],
    );

    await db.query(
      `insert into public.project_requirement_overrides (company_id, project_id, rule_key, value)
       values ($1, $2, 'site_specific_permit',
               '{"kind": "document", "required": true}'::jsonb)`,
      [companyId, project.rows[0]!.id],
    );

    const rows = await resolve(assignment.rows[0]!.id);
    const extra = rows.find((r) => r.key === "site_specific_permit");
    expect(extra).toEqual(
      expect.objectContaining({
        kind: "document",
        required: true,
        amount: null,
        policy_type: null,
        source: "project_override",
      }),
    );
  });

  it("raises for an assignment id that does not exist", async () => {
    const bogus = "00000000-0000-0000-0000-000000000000";
    await expect(resolve(bogus)).rejects.toThrow();
  });
});
