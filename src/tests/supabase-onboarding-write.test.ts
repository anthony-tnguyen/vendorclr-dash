import { describe, expect, it } from "vitest";

import { createSupabaseRepository } from "@/data/supabaseRepository";
import type { VendorClrClient } from "@/lib/supabase/client";

/**
 * Regression guard for saveOnboarding's write path.
 *
 * A Supabase write with no `.select()` chained returns `{ data: null }` on
 * success (PostgREST return=minimal). saveOnboarding must treat that as success
 * and only fail on `error`. It previously ran the response through unwrap(),
 * which throws on null data — so every "Save & continue" threw even though the
 * row was written, and the onboarding wizard never advanced a step.
 */

type UpsertResult = { data: unknown; error: { message: string } | null };

function fakeClient(upsertResult: UpsertResult): VendorClrClient {
  return {
    from(table: string) {
      if (table === "company_members") {
        return {
          select: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { company_id: "co-1" }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "company_onboarding") {
        return { upsert: async () => upsertResult };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as VendorClrClient;
}

describe("supabaseRepository.saveOnboarding", () => {
  it("resolves when the upsert returns no data (return=minimal success)", async () => {
    const repo = createSupabaseRepository(() => fakeClient({ data: null, error: null }));
    await expect(
      repo.saveOnboarding({ currentStep: 2, companyInfo: { companyName: "Halstead" } }),
    ).resolves.toBeUndefined();
  });

  it("throws when the upsert returns an error", async () => {
    const repo = createSupabaseRepository(() =>
      fakeClient({ data: null, error: { message: "permission denied" } }),
    );
    await expect(repo.saveOnboarding({ currentStep: 2 })).rejects.toThrow("permission denied");
  });
});
