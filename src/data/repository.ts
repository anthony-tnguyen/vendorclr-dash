import type { DashboardRepository } from "./contracts";
import { createDemoRepository } from "./demoRepository";

/**
 * Single seam for data access. Today it resolves to the DEMO-ONLY in-memory
 * repository; a future backend implementation would satisfy the same
 * DashboardRepository interface without touching feature code.
 */
let instance: DashboardRepository | null = null;

export function getRepository(): DashboardRepository {
  if (!instance) instance = createDemoRepository();
  return instance;
}
