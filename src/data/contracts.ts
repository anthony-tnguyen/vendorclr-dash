/**
 * Typed contracts for the VendorClr demo.
 *
 * DEMO-ONLY: every behavior described here is served from an in-memory
 * repository. Nothing is persisted, emailed, uploaded, reviewed or exported.
 */

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
  | "Fire Protection";

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

export interface OverviewMetric {
  id: string;
  label: string;
  value: string;
  detail: string;
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
  plan: "Field" | "Program" | "Enterprise";
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

export interface DashboardRepository {
  listVendors(): Promise<Vendor[]>;
  getVendor(vendorId: string): Promise<Vendor | null>;
  createVendor(draft: VendorDraft): Promise<Vendor>;
  listTasks(): Promise<TaskItem[]>;
  listOverviewMetrics(): Promise<OverviewMetric[]>;
  listReportRows(): Promise<ReportRow[]>;
  listCompanies(): Promise<Company[]>;
  listQueue(): Promise<QueueItem[]>;
  listLeads(): Promise<Lead[]>;
  listAccessGrants(): Promise<AccessGrant[]>;
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
