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

/** email_outbox.status - Phase 1 send-time value, widened by migration 19 (email_bounce_handling) to also carry the latest delivery outcome. */
export type EmailOutboxStatus =
  "queued" | "sent" | "failed" | "delivered" | "bounced" | "complained";
export type EmailOutboxTemplate = "vendor_onboarding" | "renewal_request";
export type EmailOutboxRow = Omit<Row<"email_outbox">, "status" | "template"> & {
  status: EmailOutboxStatus;
  template: EmailOutboxTemplate;
};

/** email_delivery_events.event_type - migration 19. Append-only post-send history; see that migration's own docblock for why this is separate from EmailOutboxStatus above. */
export type EmailDeliveryEventType =
  "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained";
export type EmailDeliveryEventRow = Omit<Row<"email_delivery_events">, "event_type"> & {
  event_type: EmailDeliveryEventType;
};

/** vendor_contacts.role - Task 7 (20260916000600_contacts_and_suppression.sql). */
export type VendorContactRole = "operational" | "broker" | "secondary";

export type ContactRow = Row<"contacts">;

export type VendorContactRow = Omit<Row<"vendor_contacts">, "role"> & { role: VendorContactRole };

/** suppressed_recipients.reason - Task 7. 'bounced'/'complained' are written by handle_bounce_suppression(); 'manual' is a direct company-writer insert. */
export type SuppressionReason = "bounced" | "complained" | "manual";

export type SuppressedRecipientRow = Omit<Row<"suppressed_recipients">, "reason"> & {
  reason: SuppressionReason;
};

/** upload_request_checklist_items.document_kind / package_documents.document_kind - Task 8a (20260917000300_submission_packages.sql). Kept in sync by hand across both tables' CHECK constraints - see that migration's docblock for why a Postgres domain wasn't used instead. */
export type DocumentKind =
  | "certificate_of_insurance"
  | "additional_insured_endorsement"
  | "waiver_of_subrogation_endorsement"
  | "primary_noncontributory_endorsement"
  | "other";

export type UploadRequestChecklistItemRow = Omit<
  Row<"upload_request_checklist_items">,
  "document_kind"
> & { document_kind: DocumentKind };

/** submission_packages.status - Task 8a. 'open' accepts uploads, 'finalized' has queued processing and cannot accept new checklist-slot documents, 'superseded' was replaced by a later version via replaceDeficientDocument(). */
export type SubmissionPackageStatus = "open" | "finalized" | "superseded";

export type SubmissionPackageRow = Omit<Row<"submission_packages">, "status"> & {
  status: SubmissionPackageStatus;
};

export type PackageDocumentRow = Omit<Row<"package_documents">, "document_kind"> & {
  document_kind: DocumentKind;
};

/** document_processing_jobs.job_type - Task 8a. Only one value exists today; widen when a second job type is needed. */
export type DocumentProcessingJobType = "extract_document";

/** document_processing_jobs.status - Task 8a defined the CHECK constraint including 'exhausted'; Task 8b (20260917000600_document_processing_job_worker.sql) added attempt_count/max_attempts/next_attempt_at/claimed_at/claimed_by/last_error/exhausted_at and the worker that actually drives a row through these states. */
export type DocumentProcessingJobStatus =
  "queued" | "processing" | "succeeded" | "failed" | "exhausted";

export type DocumentProcessingJobRow = Omit<
  Row<"document_processing_jobs">,
  "job_type" | "status"
> & {
  job_type: DocumentProcessingJobType;
  status: DocumentProcessingJobStatus;
};

/** document_extractions.source - Task 9a (20260917000900_versioned_extractions.sql). 'model' rows have no reviewer_id; 'reviewer_edit' rows always do - enforced at the DB level by that table's own CHECK constraint, not just by this type. */
export type DocumentExtractionSource = "model" | "reviewer_edit";

export type DocumentExtractionRow = Omit<Row<"document_extractions">, "source"> & {
  source: DocumentExtractionSource;
};
