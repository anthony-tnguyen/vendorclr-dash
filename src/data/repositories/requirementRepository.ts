import type {
  ProjectRequirementOverrideRow,
  RequirementProfileRow,
  RequirementProfileRuleRow,
} from "@/data/dbTypeAliases";
import type {
  PolicyKind,
  RequirementSource,
  ResolvedRequirement,
} from "@/domain/construction/types";

/**
 * Read-mostly repository over the construction core's requirement_profiles /
 * requirement_profile_rules / project_requirement_overrides tables, plus
 * resolve_assignment_requirements() (Task 4 -
 * supabase/migrations/20260916000300_construction_core_expand.sql).
 *
 * Same shape and conventions as projectRepository.ts - new, additive, request-
 * scoped client, consumed by a future UI (Task 5). See that file's docblock
 * for the full reasoning.
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

/** Every requirement profile for a company (including the one company default). */
export async function listRequirementProfiles(companyId: string): Promise<RequirementProfileRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("requirement_profiles")
    .select("*")
    .eq("company_id", companyId)
    .order("name", { ascending: true })) as unknown as {
    data: RequirementProfileRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** One requirement profile by id, or null if it does not exist / is not visible to the caller. */
export async function getRequirementProfile(
  profileId: string,
): Promise<RequirementProfileRow | null> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("requirement_profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle()) as unknown as {
    data: RequirementProfileRow | null;
    error: { message: string } | null;
  };
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

/** Every rule on a profile. */
export async function listProfileRules(profileId: string): Promise<RequirementProfileRuleRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("requirement_profile_rules")
    .select("*")
    .eq("profile_id", profileId)
    .order("rule_key", { ascending: true })) as unknown as {
    data: RequirementProfileRuleRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

/** Every surgical override configured on a project. */
export async function listProjectOverrides(
  projectId: string,
): Promise<ProjectRequirementOverrideRow[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase
    .from("project_requirement_overrides")
    .select("*")
    .eq("project_id", projectId)
    .order("rule_key", { ascending: true })) as unknown as {
    data: ProjectRequirementOverrideRow[] | null;
    error: { message: string } | null;
  };
  return unwrap({ data: result.data ?? [], error: result.error });
}

interface ResolveAssignmentRequirementsRpcRow {
  key: string;
  policy_type: string | null;
  kind: string;
  required: boolean;
  amount: number | null;
  source: string;
  configuration: Record<string, unknown> | null;
}

/**
 * Calls resolve_assignment_requirements(assignment_id) and maps its
 * snake_case columns onto the camelCase ResolvedRequirement shape
 * (src/domain/construction/types.ts). The precedence itself is entirely the
 * database function's responsibility - this is a thin, typed wrapper, not a
 * second implementation of it.
 */
export async function resolveAssignmentRequirements(
  assignmentId: string,
): Promise<ResolvedRequirement[]> {
  const supabase = await getRequestScopedClient();
  const result = (await supabase.rpc("resolve_assignment_requirements", {
    assignment_id: assignmentId,
  })) as unknown as {
    data: ResolveAssignmentRequirementsRpcRow[] | null;
    error: { message: string } | null;
  };
  const rows = unwrap({ data: result.data ?? [], error: result.error });

  return rows.map((row) => ({
    key: row.key,
    policyType: (row.policy_type as ResolvedRequirement["policyType"]) ?? null,
    kind: row.kind as PolicyKind,
    required: row.required,
    amount: row.amount,
    source: row.source as RequirementSource,
    configuration: row.configuration ?? {},
  }));
}
