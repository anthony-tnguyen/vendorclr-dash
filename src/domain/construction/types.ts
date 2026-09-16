import type { PolicyType } from "@/data/dbTypeAliases";

/**
 * The construction core's resolved-requirement shape - the TypeScript mirror
 * of what public.resolve_assignment_requirements(uuid) returns (see
 * supabase/migrations/20260916000300_construction_core_expand.sql).
 *
 * Deliberately scoped to only what Task 4 actually produces. The plan's
 * broader domain sketch also has EvaluationResult / EvidenceState / findings,
 * but those depend on submission packages and evidence evaluation, neither of
 * which exist yet (Task 8/9) - they do not belong here until the schema that
 * backs them does.
 */

/** Mirrors requirement_profile_rules.rule_kind's CHECK constraint. */
export type PolicyKind = "document" | "limit" | "endorsement" | "certificate_holder";

/**
 * Which precedence step (see the expand migration's docblock) produced this
 * requirement's effective value. Mirrors resolve_assignment_requirements()'s
 * `source` column exactly.
 */
export type RequirementSource =
  "company_profile" | "project_profile" | "assignment_profile" | "project_override";

/** One row of resolve_assignment_requirements(assignment_id)'s result. */
export interface ResolvedRequirement {
  key: string;
  /** Reuses the existing PolicyType union (src/data/dbTypeAliases.ts) rather than redefining it. */
  policyType: PolicyType | null;
  kind: PolicyKind;
  required: boolean;
  amount: number | null;
  source: RequirementSource;
}
