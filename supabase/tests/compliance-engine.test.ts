import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, expectDeniedByRls, signUp } from "./harness";

/**
 * apply_policy_renewal() - the one function that turns an extraction into a
 * vendor_policies write. Deliberately not security definer (see the
 * migration comment): every statement inside runs with the CALLER's own RLS,
 * so this suite exercises the same can_write_company() boundary the rest of
 * the schema depends on, plus the one property specific to this function -
 * that superseding the old row and inserting the new one is atomic.
 */

const OWNER = "11111111-1111-1111-1111-111111111111";
const READER = "22222222-2222-2222-2222-222222222222";
const RIVAL_OWNER = "33333333-3333-3333-3333-333333333333";

let db: PGlite;
let companyId: string;
let rivalCompanyId: string;
let vendorId: string;

async function activeGlPolicy(): Promise<{
  id: string;
  carrier_name: string;
  policy_number: string;
  expiration_date: string;
}> {
  const result = await db.query<{
    id: string;
    carrier_name: string;
    policy_number: string;
    expiration_date: string;
  }>(
    `select id, carrier_name, policy_number, expiration_date from public.vendor_policies
     where vendor_id = $1 and policy_type = 'general_liability' and status = 'active'`,
    [vendorId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("expected an active GL policy");
  return row;
}

beforeAll(async () => {
  db = await createTestDb();

  await signUp(db, { id: OWNER, email: "owner@halstead.test", companyName: "Halstead Builders" });
  await signUp(db, {
    id: RIVAL_OWNER,
    email: "owner@rival.test",
    companyName: "Rival Construction",
  });
  companyId = await companyIdFor(db, OWNER);
  rivalCompanyId = await companyIdFor(db, RIVAL_OWNER);

  await signUp(db, { id: READER, email: "reader@halstead.test" });
  await db.query(
    `insert into public.company_members (company_id, user_id, role) values ($1, $2, 'read_only')`,
    [companyId, READER],
  );

  const vendor = await db.query<{ id: string }>(
    `insert into public.vendors (company_id, name, trade) values ($1, 'Corbett Structural Steel', 'Structural Steel')
     returning id`,
    [companyId],
  );
  vendorId = vendor.rows[0]!.id;

  await db.query(
    `insert into public.vendor_policies (company_id, vendor_id, policy_type, carrier_name, policy_number, expiration_date, status, verification_status)
     values ($1, $2, 'general_liability', 'Travelers', 'GL-8841-2266', '2026-11-30', 'active', 'verified')`,
    [companyId, vendorId],
  );
}, 60_000);

describe("apply_policy_renewal - the write-role happy path", () => {
  it("supersedes the old row and creates a new active one, atomically", async () => {
    const before = await activeGlPolicy();

    const rows = await asUser<{ apply_policy_renewal: string }>(
      db,
      OWNER,
      `select apply_policy_renewal($1,$2,$3,'general_liability','Travelers','GL-8841-2266','2026-11-30','2027-11-30',2000000,4000000,true,true,'Halstead Builders','500 Harbor Point Way, Boston, MA 02110')`,
      [companyId, vendorId, before.id],
    );
    const newPolicyId = rows[0]?.apply_policy_renewal;
    expect(newPolicyId).toBeTruthy();
    expect(newPolicyId).not.toBe(before.id);

    const oldRow = await db.query<{ status: string }>(
      `select status from public.vendor_policies where id = $1`,
      [before.id],
    );
    expect(oldRow.rows[0]?.status).toBe("superseded");

    const newRow = await db.query<{
      status: string;
      expiration_date: Date;
      verification_status: string;
      certificate_holder_name: string;
      certificate_holder_address: string;
    }>(
      `select status, expiration_date, verification_status, certificate_holder_name, certificate_holder_address
       from public.vendor_policies where id = $1`,
      [newPolicyId],
    );
    expect(newRow.rows[0]?.status).toBe("active");
    expect(newRow.rows[0]?.verification_status).toBe("verified");
    expect(newRow.rows[0]?.expiration_date.toISOString().slice(0, 10)).toBe("2027-11-30");
    expect(newRow.rows[0]?.certificate_holder_name).toBe("Halstead Builders");
    expect(newRow.rows[0]?.certificate_holder_address).toBe(
      "500 Harbor Point Way, Boston, MA 02110",
    );

    // Exactly one active GL policy exists afterward - the partial unique
    // index this atomicity exists to protect.
    const activeCount = await db.query<{ n: number }>(
      `select count(*)::int n from public.vendor_policies
       where vendor_id = $1 and policy_type = 'general_liability' and status = 'active'`,
      [vendorId],
    );
    expect(activeCount.rows[0]?.n).toBe(1);
  });

  it("accepts null for both certificate-holder fields - not determinable is not an error", async () => {
    const before = await activeGlPolicy();

    const rows = await asUser<{ apply_policy_renewal: string }>(
      db,
      OWNER,
      `select apply_policy_renewal($1,$2,$3,'general_liability','Travelers','GL-8841-2266','2026-11-30','2030-11-30',null,null,true,true,null,null)`,
      [companyId, vendorId, before.id],
    );
    const newPolicyId = rows[0]?.apply_policy_renewal;

    const newRow = await db.query<{
      certificate_holder_name: string | null;
      certificate_holder_address: string | null;
    }>(
      `select certificate_holder_name, certificate_holder_address from public.vendor_policies where id = $1`,
      [newPolicyId],
    );
    expect(newRow.rows[0]?.certificate_holder_name).toBeNull();
    expect(newRow.rows[0]?.certificate_holder_address).toBeNull();
  });

  it("rolls back the whole call - old row stays active - when the insert violates a constraint", async () => {
    const before = await activeGlPolicy();

    await expect(
      asUser(
        db,
        OWNER,
        // An out-of-range confidence-style bad value: this policy_type does
        // not exist in the CHECK constraint, so the INSERT fails.
        `select apply_policy_renewal($1,$2,$3,'not_a_real_policy_type','Travelers','GL-8841-2266','2026-11-30','2027-11-30',null,null,true,true,null,null)`,
        [companyId, vendorId, before.id],
      ),
    ).rejects.toThrow();

    const row = await db.query<{ status: string }>(
      `select status from public.vendor_policies where id = $1`,
      [before.id],
    );
    // If the UPDATE had committed independently of the failed INSERT, this
    // would read 'superseded' with no active replacement - exactly the
    // "vendor briefly has zero active GL coverage" bug the RPC exists to
    // prevent.
    expect(row.rows[0]?.status).toBe("active");
  });
});

describe("apply_policy_renewal - RLS boundary (not security definer)", () => {
  it("refuses a read_only member - RLS runs as the caller, same as a direct write", async () => {
    const before = await activeGlPolicy();

    await expectDeniedByRls(() =>
      asUser(
        db,
        READER,
        `select apply_policy_renewal($1,$2,$3,'general_liability','Travelers','GL-8841-2266','2026-11-30','2028-11-30',null,null,true,true,null,null)`,
        [companyId, vendorId, before.id],
      ),
    );

    const row = await db.query<{ status: string }>(
      `select status from public.vendor_policies where id = $1`,
      [before.id],
    );
    expect(row.rows[0]?.status).toBe("active");
  });

  it("refuses an owner acting on a vendor outside their own company", async () => {
    const before = await activeGlPolicy();

    await expectDeniedByRls(() =>
      asUser(
        db,
        RIVAL_OWNER,
        // Names Halstead's own company_id/vendor_id/policy_id from outside -
        // can_write_company(companyId) fails for the rival owner regardless.
        `select apply_policy_renewal($1,$2,$3,'general_liability','Travelers','GL-8841-2266','2026-11-30','2029-11-30',null,null,true,true,null,null)`,
        [companyId, vendorId, before.id],
      ),
    );
  });

  it("anon cannot execute the function at all", async () => {
    const result = await db.query<{ can_exec: boolean }>(
      `select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as can_exec`,
      [
        "public.apply_policy_renewal(uuid,uuid,uuid,text,text,text,date,date,int8,int8,bool,bool,text,text)",
      ],
    );
    expect(result.rows[0]?.can_exec).toBe(false);
  });
});
