/**
 * Hand-authored database types for the Phase 0 schema.
 *
 * Regenerate rather than hand-edit once the schema settles:
 *   supabase gen types typescript --project-id <ref> > src/data/db-types.ts
 *
 * Keep these in sync with supabase/migrations/*.sql. The CHECK constraints in the
 * migrations are the source of truth for every union below.
 */

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

export interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyRow {
  id: string;
  name: string;
  plan: CompanyPlan;
  subscription_renews_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyMemberRow {
  id: string;
  company_id: string;
  user_id: string;
  role: CompanyRole;
  scope: string;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorRow {
  id: string;
  company_id: string;
  name: string;
  trade: string;
  project: string;
  contract_value: number;
  contact_name: string;
  contact_email: string;
  risk_tier: "low" | "moderate" | "high";
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorPolicyRow {
  id: string;
  company_id: string;
  vendor_id: string;
  policy_type: PolicyType;
  carrier_name: string;
  policy_number: string;
  effective_date: string | null;
  expiration_date: string | null;
  each_occurrence_limit: number | null;
  general_aggregate_limit: number | null;
  additional_insured: boolean | null;
  waiver_of_subrogation: boolean | null;
  primary_noncontributory: boolean | null;
  status: PolicyStatus;
  verification_status: VerificationStatus;
  created_at: string;
  updated_at: string;
}

export interface VendorComplianceItemRow {
  id: string;
  company_id: string;
  vendor_id: string;
  requirement_key: RequirementKey;
  status: RequirementStatus;
  effective_date: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorCoverageLimitRow {
  id: string;
  company_id: string;
  vendor_id: string;
  label: string;
  required_amount: number;
  carried_amount: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  company_id: string;
  vendor_id: string | null;
  title: string;
  due_on: string | null;
  priority: "high" | "medium" | "low";
  status: "open" | "waiting" | "done";
  owner: string;
  created_at: string;
  updated_at: string;
}

export interface ComplianceQueueItemRow {
  id: string;
  company_id: string;
  vendor_id: string;
  document_label: string;
  submitted_on: string;
  state: "queued" | "in-review" | "escalated";
  created_at: string;
  updated_at: string;
}

export type UploadRequestPurpose = "renewal" | "initial" | "correction";
export type UploadRequestStatus =
  | "pending"
  | "email_sent"
  | "opened"
  | "uploaded"
  | "processing"
  | "completed"
  | "needs_review"
  | "expired"
  | "cancelled";

export interface VendorUploadRequestRow {
  id: string;
  company_id: string;
  vendor_id: string;
  token_hash: string;
  purpose: UploadRequestPurpose;
  status: UploadRequestStatus;
  expires_at: string;
  opened_at: string | null;
  uploaded_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentSource = "vendor_portal" | "client_upload" | "admin" | "email";
export type DocumentProcessingStatus =
  "uploaded" | "processing" | "processed" | "needs_review" | "failed";

export interface VendorDocumentRow {
  id: string;
  company_id: string;
  vendor_id: string;
  upload_request_id: string | null;
  storage_path: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  source: DocumentSource;
  processing_status: DocumentProcessingStatus;
  processing_error: string | null;
  /** Validated against InsuranceExtractionSchema (src/workflows/insuranceExtractionSchema.ts). Null until processed/needs_review. */
  parsed_data: Record<string, unknown> | null;
  /** Mirrors parsed_data.overall_confidence for cheap SQL filtering. 0-1, or null. */
  extraction_confidence: number | null;
  /** Set when an earlier document for the same vendor shares this file's sha256. */
  duplicate_of_document_id: string | null;
  uploaded_at: string;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type EmailTemplate = "vendor_onboarding" | "renewal_request";
export type EmailStatus = "queued" | "sent" | "failed";

export interface EmailOutboxRow {
  id: string;
  company_id: string;
  vendor_id: string;
  upload_request_id: string | null;
  template: EmailTemplate;
  to_email: string;
  status: EmailStatus;
  provider_message_id: string | null;
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface LeadRow {
  id: string;
  company_name: string;
  contact_name: string;
  trade: string;
  source: string;
  stage: "new" | "qualified" | "demo" | "closed";
  created_on: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyReportRowView {
  id: string;
  company_id: string;
  project: string;
  vendors: number;
  compliant_pct: number;
  expiring_in_30: number;
  open_exceptions: number;
}

export interface AdminCompanyStatsView {
  id: string;
  name: string;
  plan: CompanyPlan;
  subscription_renews_on: string | null;
  vendor_count: number;
  seat_count: number;
  compliance_rate: number;
}

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type View<Row> = { Row: Row; Relationships: [] };

export interface Database {
  public: {
    Tables: {
      profiles: Table<ProfileRow>;
      companies: Table<CompanyRow>;
      company_members: Table<CompanyMemberRow>;
      vendors: Table<
        VendorRow,
        Pick<VendorRow, "company_id" | "name" | "trade"> & Partial<VendorRow>
      >;
      vendor_policies: Table<
        VendorPolicyRow,
        Pick<VendorPolicyRow, "company_id" | "vendor_id" | "policy_type"> & Partial<VendorPolicyRow>
      >;
      vendor_compliance_items: Table<
        VendorComplianceItemRow,
        Pick<VendorComplianceItemRow, "company_id" | "vendor_id" | "requirement_key"> &
          Partial<VendorComplianceItemRow>
      >;
      vendor_coverage_limits: Table<
        VendorCoverageLimitRow,
        Pick<VendorCoverageLimitRow, "company_id" | "vendor_id" | "label"> &
          Partial<VendorCoverageLimitRow>
      >;
      tasks: Table<TaskRow, Pick<TaskRow, "company_id" | "title"> & Partial<TaskRow>>;
      compliance_queue_items: Table<
        ComplianceQueueItemRow,
        Pick<ComplianceQueueItemRow, "company_id" | "vendor_id" | "document_label"> &
          Partial<ComplianceQueueItemRow>
      >;
      vendor_upload_requests: Table<
        VendorUploadRequestRow,
        Pick<VendorUploadRequestRow, "company_id" | "vendor_id" | "token_hash" | "expires_at"> &
          Partial<VendorUploadRequestRow>
      >;
      vendor_documents: Table<
        VendorDocumentRow,
        Pick<
          VendorDocumentRow,
          | "company_id"
          | "vendor_id"
          | "storage_path"
          | "file_name"
          | "mime_type"
          | "file_size"
          | "sha256"
        > &
          Partial<VendorDocumentRow>
      >;
      email_outbox: Table<
        EmailOutboxRow,
        Pick<EmailOutboxRow, "company_id" | "vendor_id" | "template" | "to_email"> &
          Partial<EmailOutboxRow>
      >;
      leads: Table<LeadRow, Pick<LeadRow, "company_name"> & Partial<LeadRow>>;
    };
    Views: {
      company_report_rows: View<CompanyReportRowView>;
      admin_company_stats: View<AdminCompanyStatsView>;
    };
    Functions: {
      create_company_for_current_user: {
        Args: { company_name: string; member_name?: string | null };
        Returns: string;
      };
      is_platform_admin: { Args: Record<string, never>; Returns: boolean };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
