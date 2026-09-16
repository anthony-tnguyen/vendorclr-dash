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
 *
 * signup_invites is the one table below NOT derived from Database: the live
 * project this file was generated against had not yet had
 * 20260915000100_gated_signup_invites.sql applied when
 * 20260916000100_company_feature_flags.sql was deployed and types were
 * regenerated (a pre-existing deploy gap, unrelated to feature flags - see
 * that PR/task for remediation). Once that migration is live and types are
 * regenerated, SignupInviteRow should move to the derived form below, same
 * as every other table.
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

export type LeadRow = Omit<Row<"leads">, "stage"> & { stage: LeadStage };

export type CompanyReportRowView = NonNullableRow<ViewRow<"company_report_rows">>;

export type AdminCompanyStatsView = Omit<NonNullableRow<ViewRow<"admin_company_stats">>, "plan"> & {
  plan: CompanyPlan;
};

/**
 * Not derived from Database - see the file-level comment above. Matches the
 * columns supabase/migrations/20260915000100_gated_signup_invites.sql
 * defines on public.signup_invites.
 */
export interface SignupInviteRow {
  id: string;
  code: string;
  email: string;
  company_name: string;
  status: SignupInviteStatus;
  expires_at: string;
  created_by: string | null;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
  updated_at: string;
}
