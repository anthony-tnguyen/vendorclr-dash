import type { DashboardRepository } from "./contracts";
import { createDemoRepository } from "./demoRepository";
import { createSupabaseRepository } from "./supabaseRepository";
import { hasBackendEnv } from "@/lib/supabase/env";

/**
 * Single seam for data access.
 *
 * Resolves to the Supabase repository when VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY are set, and to the DEMO-ONLY in-memory repository
 * otherwise. Both satisfy DashboardRepository, so no feature code branches on it.
 *
 * Keeping the demo path is what lets the Vitest suite and the Lovable preview run
 * with no database and no secrets.
 */
let instance: DashboardRepository | null = null;

export function getRepository(): DashboardRepository {
  if (!instance) {
    instance = hasBackendEnv() ? createSupabaseRepository() : createDemoRepository();
  }
  return instance;
}

/** True when getRepository() is talking to a real backend. */
export function isBackendConfigured(): boolean {
  return hasBackendEnv();
}

/** Test seam: forces the next getRepository() call to re-resolve the flag. */
export function resetRepository(): void {
  instance = null;
}
