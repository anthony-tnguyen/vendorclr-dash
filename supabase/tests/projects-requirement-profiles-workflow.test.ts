import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, companyIdFor, createTestDb, signUp } from "./harness";

const OWNER = "9b332c55-bd41-45b9-95ef-ef3f075e5f13";

let db: PGlite;
let companyId: string;

beforeAll(async () => {
  db = await createTestDb();
  await signUp(db, { id: OWNER, email: "projects-owner@halstead.test", companyName: "Halstead Builders" });
  companyId = await companyIdFor(db, OWNER);
}, 60_000);

describe("customer projects and requirement profiles", () => {
  it("stores a project location and prevents an archived profile from being selected", async () => {
    const storedProject = await asUser<{ location: string }>(
      db,
      OWNER,
      `insert into public.projects (company_id, name, location)
       values ($1, 'Location Site', '100 Main St, Oakland, CA')
       returning location`,
      [companyId],
    );
    expect(storedProject[0]?.location).toBe("100 Main St, Oakland, CA");

    const profile = await db.query<{ id: string }>(
      `insert into public.requirement_profiles (company_id, name)
       values ($1, 'Archived profile') returning id`,
      [companyId],
    );

    await db.query(
      `update public.requirement_profiles set archived_at = now() where id = $1`,
      [profile.rows[0]!.id],
    );

    await expect(
      asUser(
        db,
        OWNER,
        `insert into public.projects (company_id, name, location, default_requirement_profile_id)
         values ($1, 'Archive Guard Site', '100 Main St, Oakland, CA', $2)`,
        [companyId, profile.rows[0]!.id],
      ),
    ).rejects.toThrow(/archived/i);
  });
});
