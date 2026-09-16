import type { Database } from "./db-types";

/**
 * Precise, literal-typed convenience aliases over the generated schema in
 * db-types.ts.
 *
 * `supabase gen types typescript` widens every CHECK-constrained text column
 * to plain `string` - none of them are backed by a real Postgres enum, and
 * the generator has no way to see a CHECK expression's allowed values. These
 * aliases restore the literal unions supabaseRepository.ts relies on for
 * exhaustive handling and safe casts, mirroring each column's CHECK
 * constraint by hand. Keep them in sync with the migration that owns each
 * constraint - nothing enforces that automatically. That manual step is the
 * trade db-types.ts's now being genuinely generated makes: this file is
 * deliberately separate from db-types.ts and not something `supabase gen
 * types` output ever touches. (No CI job regenerates/diffs db-types.ts yet
 * either way - see "No CI job regenerates..." in supabase/README.md's Known
 * compromises - but this file would stay hand-maintained even once one
 * exists, since it's not generated output at all.)
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];
type ViewRow<T extends keyof Database["public"]["Views"]> = Database["public"]["Views"][T]["Row"];

/**
 * The generator marks every view column nullable - it has no way to see
 * that a view built entirely from NOT NULL source columns and COALESCE'd
 * aggregates (company_report_rows, admin_company_stats - see
 * 20260901000300_tasks_queue_leads_and_views.sql) never actually produces a
 * null. Restores the non-null shape the original hand-authored view types
 * had, which listReportRows()/listCompanies() in supabaseRepository.ts
 * already assume.
 */
type NonNullableRow<T> = { [K in keyof T]: NonNullable<T[K]> };

export type CompanyPlan = "Field" | "Program" | "Enterprise";
export type CompanyRole = "owner" | "risk_manager" | "project_engineer" | "read_only";

export type PolicyType =
  | "general_liability"
  | "workers_compensation"
  | "commercial_auto"
  | "umbrella"
  | "professional_liability"
  | "pollution_liability"
  | "builders_risk";

export type PolicyStatus = "active" | "expired" | "superseded" | "cancelled";
export type VerificationStatus = "unverified" | "needs_review" | "verified" | "rejected";
export type RequirementKey =
  "coi" | "additionalInsured" | "waiverOfSubrogation" | "lienWaiver" | "renewal";
export type RequirementStatus = "compliant" | "expiring" | "missing" | "expired" | "pending";
export type LimitField = "each_occurrence_limit" | "general_aggregate_limit";
export type SignupInviteStatus = "pending" | "used" | "revoked";
export type LeadStage = "new" | "qualified" | "demo" | "closed";

export type VendorRow = Omit<Row<"vendors">, "risk_tier"> & {
  risk_tier: "low" | "moderate" | "high";
};

export type VendorPolicyRow = Omit<
  Row<"vendor_policies">,
  "policy_type" | "status" | "verification_status"
> & {
  policy_type: PolicyType;
  status: PolicyStatus;
  verification_status: VerificationStatus;
};

export type VendorComplianceItemRow = Omit<
  Row<"vendor_compliance_items">,
  "requirement_key" | "status"
> & {
  requirement_key: RequirementKey;
  status: RequirementStatus;
};

export type ComplianceRequirementRow = Omit<
  Row<"compliance_requirements">,
  "policy_type" | "limit_field"
> & {
  policy_type: PolicyType;
  limit_field: LimitField;
};

export type ProjectStatus = "active" | "on_hold" | "closed";
export type AssignmentStatus = "active" | "completed" | "terminated";
export type RuleKind = "document" | "limit" | "endorsement" | "certificate_holder";

export type ProjectRow = Omit<Row<"projects">, "status"> & { status: ProjectStatus };

export type ProjectVendorAssignmentRow = Omit<
  Row<"project_vendor_assignments">,
  "trade_code" | "risk_classification" | "status"
> & {
  trade_code: VendorRow["trade"] | null;
  risk_classification: VendorRow["risk_tier"] | null;
  status: AssignmentStatus;
};

export type RequirementProfileRow = Row<"requirement_profiles">;

export type RequirementProfileRuleRow = Omit<
  Row<"requirement_profile_rules">,
  "policy_type" | "rule_kind"
> & {
  policy_type: PolicyType | null;
  rule_kind: RuleKind;
};

export type ProjectRequirementOverrideRow = Row<"project_requirement_overrides">;

export type LeadRow = Omit<Row<"leads">, "stage"> & { stage: LeadStage };

export type SignupInviteRow = Omit<Row<"signup_invites">, "status"> & {
  status: SignupInviteStatus;
};

/** company_invitations.status - Task 6. Distinct from SignupInviteStatus above: this gates a teammate invite to an existing company, not a new-company signup. */
export type CompanyInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export type CompanyInvitationRow = Omit<Row<"company_invitations">, "status" | "role"> & {
  status: CompanyInvitationStatus;
  role: CompanyRole;
};

/** company_members with Task 6's deactivated_at/deactivated_by soft-removal columns folded into CompanyRole's literal union for `role`. */
export type CompanyMemberRow = Omit<Row<"company_members">, "role"> & { role: CompanyRole };

export type CompanyReportRowView = NonNullableRow<ViewRow<"company_report_rows">>;

export type AdminCompanyStatsView = Omit<NonNullableRow<ViewRow<"admin_company_stats">>, "plan"> & {
  plan: CompanyPlan;
};
