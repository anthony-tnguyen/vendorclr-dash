/**
 * Typed contracts for the VendorClr demo.
 *
 * DEMO-ONLY: every behavior described here is served from an in-memory
 * repository. Nothing is persisted, emailed, uploaded, reviewed or exported.
 */

import type { CompanyPlan, CompanyRole, CompanyServiceStatus } from "./dbTypeAliases";

export type DemoRole = "customer" | "admin";

export type ComplianceKey =
  "coi" | "additionalInsured" | "waiverOfSubrogation" | "lienWaiver" | "renewal";

export type ComplianceStatus = "compliant" | "expiring" | "missing" | "expired" | "pending";

export interface ComplianceItem {
  key: ComplianceKey;
  status: ComplianceStatus;
  /** ISO date (yyyy-mm-dd) or null when not applicable. */
  effectiveDate: string | null;
  note?: string | undefined;
}

export interface CoverageLimit {
  label: string;
  required: number;
  carried: number;
}

export type VendorTrade =
  | "Structural Steel"
  | "Electrical"
  | "Mechanical / HVAC"
  | "Concrete"
  | "Earthwork"
  | "Roofing"
  | "Glazing"
  | "Fire Protection"
  | "Other";

export interface Vendor {
  id: string;
  name: string;
  trade: VendorTrade;
  project: string;
  contractValue: number;
  contactName: string;
  contactEmail: string;
  policyNumber: string;
  expiresOn: string;
  /**
   * Who the vendor's current certificate actually names as certificate
   * holder - from the extraction that produced the primary policy, not
   * anything this app asserts is correct. "Not on file" (never "—" alone,
   * which reads ambiguously here) when there's no policy yet or the
   * extraction never captured one. Exists so a company can eyeball whether
   * its own vendors actually named it correctly on their certificates, not
   * just that coverage exists - see supabaseRepository.ts's toVendor().
   */
  certificateHolderName: string;
  certificateHolderAddress: string;
  riskTier: "low" | "moderate" | "high";
  compliance: ComplianceItem[];
  limits: CoverageLimit[];
}

export interface VendorDraft {
  name: string;
  trade: VendorTrade;
  project: string;
  contactName: string;
  contactEmail: string;
  contractValue: number;
}

export interface TaskItem {
  id: string;
  title: string;
  vendorId: string | null;
  vendorName: string;
  dueOn: string;
  priority: "high" | "medium" | "low";
  status: "open" | "waiting" | "done";
  owner: string;
}

export interface ReportRow {
  id: string;
  project: string;
  vendors: number;
  compliantPct: number;
  expiringIn30: number;
  openExceptions: number;
}

export interface Company {
  id: string;
  name: string;
  plan: CompanyPlan;
  vendors: number;
  seats: number;
  complianceRate: number;
  renewalOn: string;
}

export interface QueueItem {
  id: string;
  vendorName: string;
  company: string;
  document: string;
  submittedOn: string;
  state: "queued" | "in-review" | "escalated" | "resolved";
  /**
   * The vendor_documents row this item was created for - present in live mode
   * (migration 12), absent in the demo repository, which has no document
   * review flow to link to. Only listQueue() callers that can act on an item
   * (the review screen link) need this; everything else already worked
   * without it.
   */
  documentId?: string | null;
}

export interface Lead {
  id: string;
  company: string;
  contact: string;
  trade: string;
  source: string;
  createdOn: string;
  stage: "new" | "qualified" | "demo" | "closed";
}

export interface AccessGrant {
  id: string;
  person: string;
  email: string;
  role: "Owner" | "Risk Manager" | "Project Engineer" | "Read only";
  scope: string;
  lastActiveOn: string;
}

/**
 * Staff view of one company membership, for the admin Access console. Unlike
 * AccessGrant (a flat display row), this carries the raw ids and role the staff
 * mutations need, the company it belongs to, and whether the user is also a
 * VendorClr staff account (platform_admins).
 */
export interface AdminMember {
  /** company_members.id — the handle every membership mutation takes. */
  id: string;
  userId: string;
  person: string;
  email: string;
  companyId: string;
  companyName: string;
  role: CompanyRole;
  isPlatformAdmin: boolean;
  lastActiveOn: string;
}

/** A VendorClr staff account (platform_admins), possibly with no company. */
export interface AdminStaff {
  userId: string;
  person: string;
  email: string;
}

/**
 * Paid-access model. An activation code is issued by VendorClr staff after
 * payment, is single-use and locked to one email address, and creates a company
 * when redeemed. It is not a payment instrument: nothing bills against a code,
 * and no provider is called to validate one.
 *
 * This replaces invite-gated signup
 * (supabase/migrations/20260915000100_gated_signup_invites.sql). Those rows are
 * left where they are: permission to register and payment for a workspace are
 * different facts, and folding them together would make the old rows look like
 * codes they never were.
 */
export interface ActivationCode {
  id: string;
  code: string;
  email: string;
  companyName: string;
  plan: CompanyPlan;
  status: "pending" | "used" | "revoked";
  /** ISO date or null - when set, copied onto the new company's renewal date. */
  renewsOn: string | null;
  note: string | null;
  createdOn: string;
  /** ISO timestamp or null while the code is still outstanding. */
  usedOn: string | null;
}

export interface ActivationCodeDraft {
  email: string;
  companyName: string;
  plan: CompanyPlan;
  renewsOn?: string | null;
  note?: string | null;
}

/** What redeeming a code produced - the workspace the caller now owns. */
export interface ActivatedWorkspace {
  companyId: string;
  companyName: string;
  plan: CompanyPlan;
}

/**
 * Post-checkout onboarding wizard state (company_onboarding). Steps 1-3 and 5
 * are captured as free-form objects the VendorClr team reviews; step 4 (vendors)
 * is real data created through the CSV / COI importers. The gate on the console
 * is companies.service_status, exposed through the session, not stored here.
 */
export interface OnboardingState {
  currentStep: number;
  companyInfo: Record<string, unknown>;
  program: Record<string, unknown>;
  projects: Record<string, unknown>;
  requirements: Record<string, unknown>;
  submittedAt: string | null;
  reviewedAt: string | null;
}

export interface OnboardingPatch {
  currentStep?: number;
  companyInfo?: Record<string, unknown>;
  program?: Record<string, unknown>;
  projects?: Record<string, unknown>;
  requirements?: Record<string, unknown>;
}

/** Active-vendor usage against the plan ceiling, for the utilization notice. */
export interface VendorUsage {
  activeVendors: number;
  /** null = unlimited (Enterprise). */
  maxActiveVendors: number | null;
  /** 0..1; 0 when the plan has no ceiling. */
  utilization: number;
}

/**
 * A company still moving through onboarding, as VendorClr staff see it for the
 * Step 6 review: the wizard's submitted answers plus enough context (plan,
 * active-vendor count, where they are) to validate the setup and launch. Read
 * only by staff (RLS returns nothing to anyone who is not VendorClr staff).
 */
export interface OnboardingReview {
  companyId: string;
  companyName: string;
  plan: CompanyPlan;
  serviceStatus: CompanyServiceStatus;
  currentStep: number;
  companyInfo: Record<string, unknown>;
  program: Record<string, unknown>;
  projects: Record<string, unknown>;
  requirements: Record<string, unknown>;
  /** Non-archived vendors this company has created so far. */
  activeVendors: number;
  /** Set once the customer finishes the wizard (service_status -> in_review). */
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface DashboardRepository {
  listVendors(): Promise<Vendor[]>;
  getVendor(vendorId: string): Promise<Vendor | null>;
  createVendor(draft: VendorDraft): Promise<Vendor>;
  listTasks(): Promise<TaskItem[]>;
  listReportRows(): Promise<ReportRow[]>;
  listCompanies(): Promise<Company[]>;
  listQueue(): Promise<QueueItem[]>;
  listLeads(): Promise<Lead[]>;
  listAccessGrants(): Promise<AccessGrant[]>;
  /** Staff-only list; RLS returns nothing to anyone who is not VendorClr staff. */
  listActivationCodes(): Promise<ActivationCode[]>;
  createActivationCode(draft: ActivationCodeDraft): Promise<ActivationCode>;
  revokeActivationCode(codeId: string): Promise<ActivationCode>;
  /** The customer-facing unlock. Throws with the database's message on any failure. */
  redeemActivationCode(code: string): Promise<ActivatedWorkspace>;
  /** Staff-only: open or close an existing workspace without deleting anything. */
  setCompanyActivation(
    companyId: string,
    activation: "demo" | "activated" | "revoked",
  ): Promise<void>;
  /**
   * Self-checkout. Starts a Stripe Checkout session for a self-serve plan and
   * returns the hosted Checkout URL to redirect the buyer to. Runs the
   * `create-checkout` Edge Function, which is where the Stripe secret lives.
   */
  createCheckoutSession(plan: CompanyPlan): Promise<{ url: string }>;
  /**
   * Opens the Stripe customer billing portal for the caller's company and
   * returns the portal URL. Runs the `billing-portal` Edge Function.
   */
  createBillingPortalSession(): Promise<{ url: string }>;
  /** The caller's onboarding wizard state, or null if no row exists yet. */
  getOnboarding(): Promise<OnboardingState | null>;
  /** Upsert the wizard's progress and answers (only the provided fields change). */
  saveOnboarding(patch: OnboardingPatch): Promise<void>;
  /** Mark the wizard finished: moves the company from onboarding to in_review. */
  submitOnboarding(): Promise<void>;
  /** Active-vendor count vs the plan ceiling, for the utilization notice. */
  getVendorUsage(): Promise<VendorUsage>;
  /**
   * Staff-only: companies in onboarding / in_review, with the wizard answers
   * for the Step 6 review. RLS returns nothing to a non-staff caller.
   */
  listOnboardingReviews(): Promise<OnboardingReview[]>;
  /** Staff-only: move a company's managed-service status (e.g. launch to live). */
  setCompanyServiceStatus(
    companyId: string,
    status: "onboarding" | "in_review" | "live",
  ): Promise<void>;
  /**
   * Staff-only: send a submitted company back to the customer to fix. Moves it
   * from in_review to onboarding and clears submitted_at. RLS/RPC re-check staff.
   */
  requestCompanyChanges(companyId: string): Promise<void>;

  // --- Staff account & company management ---------------------------------
  // Every mutation below is a platform-admin-gated RPC (see
  // supabase/migrations/20261009120000_admin_account_and_company_management.sql).
  // The reads rely on the is_platform_admin() branch of each table's SELECT
  // policy, so a non-staff caller gets nothing back.

  /** Active company memberships across every company, for the Access console. */
  listAdminMembers(): Promise<AdminMember[]>;
  /** Every VendorClr staff account (platform_admins), company or not. */
  listPlatformAdmins(): Promise<AdminStaff[]>;
  /** Resolve a user by email to grant them staff access; null if none. */
  findUserByEmail(email: string): Promise<AdminStaff | null>;
  /** Change one membership's role. Refuses to drop a company's last owner. */
  setCompanyMemberRole(memberId: string, role: CompanyRole): Promise<void>;
  /** Soft-remove a membership. Refuses to drop a company's last owner. */
  removeCompanyMember(memberId: string): Promise<void>;
  /** Grant or revoke super-admin. Refuses to revoke the caller's own access. */
  setPlatformAdmin(userId: string, enabled: boolean): Promise<void>;
  /** Email the user a password-reset link (the public reset flow). */
  sendPasswordReset(email: string): Promise<void>;
  /** Staff-only: change a company's plan. */
  setCompanyPlan(companyId: string, plan: CompanyPlan): Promise<void>;

  // --- Managed service: act on a customer company's vendors ----------------
  /** Staff-only: the given company's active vendors (read via is_platform_admin). */
  listCompanyVendors(companyId: string): Promise<Vendor[]>;
  /** Staff-only: add a vendor on a company's behalf (admin_create_vendor RPC). */
  adminCreateVendor(companyId: string, draft: VendorDraft): Promise<Vendor>;
}

export const COMPLIANCE_LABELS: Record<ComplianceKey, string> = {
  coi: "COI",
  additionalInsured: "Additional Insured",
  waiverOfSubrogation: "Waiver of Subrogation",
  lienWaiver: "Lien Waiver",
  renewal: "Renewal",
};

export const COMPLIANCE_SHORT: Record<ComplianceKey, string> = {
  coi: "COI",
  additionalInsured: "Add Ins",
  waiverOfSubrogation: "WOS",
  lienWaiver: "Lien Waiver",
  renewal: "REN",
};

export const STATUS_LABELS: Record<ComplianceStatus, string> = {
  compliant: "Compliant",
  expiring: "Expiring",
  missing: "Missing",
  expired: "Expired",
  pending: "In review",
};
