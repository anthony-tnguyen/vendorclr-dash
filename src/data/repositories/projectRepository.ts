import type { ProjectRow, ProjectVendorAssignmentRow } from "@/data/dbTypeAliases";

/**
 * Read-mostly repository over the construction core's projects /
 * project_vendor_assignments tables (Task 4 -
 * supabase/migrations/20260916000300_construction_core_expand.sql).
 *
 * New, focused and additive - per the plan's direction to split new data
 * access by domain instead of growing src/data/repository.ts /
 * supabaseRepository.ts further, this file does not touch either of those.
 * It is consumed by a future UI (Task 5, not built yet), so it stays
 * intentionally small: typed list/get functions over what the schema
 * produces today, nothing speculative.
 *
 * Uses the request-scoped Supabase client (RLS-scoped, runs as the signed-in
 * caller), the same convention supabaseRepository.ts's browser-side reads and
 * featureFlags.ts's server-side reads both already follow - never the
 * service-role client, which is reserved for the anonymous vendor-portal and
 * staff-only admin paths (see src/lib/supabase/serverClient.server.ts). Every
 * function below already assumes RLS decides visibility; it never re-checks
 * company_id itself.
 *
 * Loaded lazily inside each function: a static import of the *.server module
 * would put it in the client import graph the moment client code (a future
 * route/component) imports anything from this file - see the same pattern in
 * src/domain/featureFlags.ts and src/workflows/vendorUploadRequests.ts.
 */
async function getRequestScopedClient() {
  const mod = await import("@/lib/supabase/serverClient.server");
  return mod.getRequestScopedClient();
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data and no error");
  return result.data;
}

/** Every project for a company, most recently created first. */
export async function listProjects(companyId: string): Promise<ProjectRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("projects")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })) as unknown as {
    data: ProjectRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** One project by id, or null if it does not exist / is not visible to the caller. */
export async function getProject(projectId: string): Promise<ProjectRow | null> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle()) as unknown as {
    data: ProjectRow | null;
    error: { message: string } | null;
  };
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/** Every vendor assignment on a project, most recently created first. */
export async function listAssignmentsForProject(
  projectId: string,
): Promise<ProjectVendorAssignmentRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("project_vendor_assignments")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })) as unknown as {
    data: ProjectVendorAssignmentRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/**
 * Every project a vendor is assigned to. A vendor can appear on several
 * projects at once - this is the query that surfaces all of them, unlike the
 * legacy vendors.project single text field.
 */
export async function listAssignmentsForVendor(
  vendorId: string,
): Promise<ProjectVendorAssignmentRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("project_vendor_assignments")
    .select("*")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })) as unknown as {
    data: ProjectVendorAssignmentRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** One assignment by id, or null if it does not exist / is not visible to the caller. */
export async function getAssignment(
  assignmentId: string,
): Promise<ProjectVendorAssignmentRow | null> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("project_vendor_assignments")
    .select("*")
    .eq("id", assignmentId)
    .maybeSingle()) as unknown as {
    data: ProjectVendorAssignmentRow | null;
    error: { message: string } | null;
  };
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
