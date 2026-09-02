import type {
  AccessGrant,
  Company,
  ComplianceItem,
  ComplianceKey,
  ComplianceStatus,
  CoverageLimit,
  DashboardRepository,
  Lead,
  OverviewMetric,
  QueueItem,
  ReportRow,
  TaskItem,
  Vendor,
  VendorDraft,
  VendorTrade,
} from "./contracts";
import type {
  AdminCompanyStatsView,
  CompanyReportRowView,
  CompanyRole,
  LeadRow,
  VendorComplianceItemRow,
  VendorCoverageLimitRow,
  VendorPolicyRow,
  VendorRow,
} from "./db-types";
import { getSupabaseClient, type VendorClearClient } from "@/lib/supabase/client";

/**
 * Supabase-backed DashboardRepository.
 *
 * Tenancy is enforced by RLS, not by this file. Every select below is written as
 * though it could see everything; the database returns only the caller's company.
 * The explicit company_id on writes exists because inserts must *name* a company,
 * and the WITH CHECK policy then verifies the caller may write to it.
 */

const RAIL_ORDER: ComplianceKey[] = [
  "coi",
  "additionalInsured",
  "waiverOfSubrogation",
  "lienWaiver",
  "renewal",
];

const ROLE_LABELS: Record<CompanyRole, AccessGrant["role"]> = {
  owner: "Owner",
  risk_manager: "Risk Manager",
  project_engineer: "Project Engineer",
  read_only: "Read only",
};

/** Matches the placeholders createVendor() uses in the demo repository. */
const NO_POLICY_NUMBER = "PENDING";
const NO_EXPIRY = "—";

export interface VendorWithChildren extends VendorRow {
  vendor_policies: VendorPolicyRow[];
  vendor_compliance_items: VendorComplianceItemRow[];
  vendor_coverage_limits: VendorCoverageLimitRow[];
}

const VENDOR_SELECT = `
  *,
  vendor_policies (*),
  vendor_compliance_items (*),
  vendor_coverage_limits (*)
`;

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Supabase returned no data and no error");
  return result.data;
}

/**
 * The vendor's headline policy, flattened onto Vendor.policyNumber/expiresOn for
 * the existing UI contract. General liability wins because it is the policy every
 * construction requirement is written against; otherwise fall back to whichever
 * active policy lapses first, since that is the one that needs attention.
 */
export function primaryPolicy(policies: VendorPolicyRow[]): VendorPolicyRow | null {
  const active = policies.filter((p) => p.status === "active");
  if (active.length === 0) return null;

  const gl = active.filter((p) => p.policy_type === "general_liability");
  const pool = gl.length > 0 ? gl : active;

  return pool.reduce((soonest, candidate) => {
    if (!candidate.expiration_date) return soonest;
    if (!soonest.expiration_date) return candidate;
    return candidate.expiration_date < soonest.expiration_date ? candidate : soonest;
  }, pool[0]!);
}

export function toComplianceItems(rows: VendorComplianceItemRow[]): ComplianceItem[] {
  const byKey = new Map(rows.map((row) => [row.requirement_key, row]));

  // Always emit all five segments in rail order. A vendor missing a row renders as
  // "missing" rather than collapsing the rail to fewer segments.
  return RAIL_ORDER.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      status: (row?.status ?? "missing") as ComplianceStatus,
      effectiveDate: row?.effective_date ?? null,
      note: row?.note ?? undefined,
    };
  });
}

export function toCoverageLimits(rows: VendorCoverageLimitRow[]): CoverageLimit[] {
  return [...rows]
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
    .map((row) => ({
      label: row.label,
      required: row.required_amount,
      carried: row.carried_amount,
    }));
}

export function toVendor(row: VendorWithChildren): Vendor {
  const policy = primaryPolicy(row.vendor_policies ?? []);

  return {
    id: row.id,
    name: row.name,
    trade: row.trade as VendorTrade,
    project: row.project,
    contractValue: row.contract_value,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    policyNumber: policy?.policy_number || NO_POLICY_NUMBER,
    expiresOn: policy?.expiration_date ?? NO_EXPIRY,
    riskTier: row.risk_tier,
    compliance: toComplianceItems(row.vendor_compliance_items ?? []),
    limits: toCoverageLimits(row.vendor_coverage_limits ?? []),
  };
}

function isoDate(value: string | null): string {
  return value ?? NO_EXPIRY;
}

export function createSupabaseRepository(
  clientFactory: () => VendorClearClient = getSupabaseClient,
): DashboardRepository {
  let companyIdPromise: Promise<string> | null = null;

  /**
   * The caller's company. Phase 0 assumes one company per user and takes the
   * oldest membership; multi-company users need an explicit company switcher in
   * the session context before this becomes correct.
   */
  function resolveCompanyId(): Promise<string> {
    if (!companyIdPromise) {
      companyIdPromise = (async () => {
        const supabase = clientFactory();
        const { data, error } = await supabase
          .from("company_members")
          .select("company_id")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (error) throw new Error(error.message);
        if (!data) {
          throw new Error(
            "Signed-in user belongs to no company. Call create_company_for_current_user() during signup.",
          );
        }
        return data.company_id;
      })();

      // Do not cache a rejection; a transient network failure would otherwise
      // wedge every later call for the lifetime of the tab.
      companyIdPromise.catch(() => {
        companyIdPromise = null;
      });
    }

    return companyIdPromise;
  }

  async function loadVendors(): Promise<VendorWithChildren[]> {
    const supabase = clientFactory();
    // Cast: the hand-written Database type declares no PostgREST relationships, so
    // embedded selects cannot be inferred. `supabase gen types` removes this cast.
    const result = (await supabase
      .from("vendors")
      .select(VENDOR_SELECT)
      .is("archived_at", null)
      .order("created_at", { ascending: false })) as unknown as {
      data: VendorWithChildren[] | null;
      error: { message: string } | null;
    };

    return unwrap(result);
  }

  // Defined in the closure rather than as a sibling method: callers pass these
  // around unbound (VendorForm does `mutationFn: repo.createVendor`), so nothing
  // here may depend on `this`.
  async function loadVendorById(vendorId: string): Promise<Vendor | null> {
    const supabase = clientFactory();
    const result = (await supabase
      .from("vendors")
      .select(VENDOR_SELECT)
      .eq("id", vendorId)
      .maybeSingle()) as unknown as {
      data: VendorWithChildren | null;
      error: { message: string } | null;
    };

    if (result.error) throw new Error(result.error.message);
    return result.data ? toVendor(result.data) : null;
  }

  return {
    async listVendors() {
      return (await loadVendors()).map(toVendor);
    },

    getVendor: loadVendorById,

    async createVendor(draft: VendorDraft) {
      const supabase = clientFactory();
      const companyId = await resolveCompanyId();

      const inserted = unwrap<{ id: string }>(
        await supabase
          .from("vendors")
          .insert({
            company_id: companyId,
            name: draft.name,
            trade: draft.trade,
            project: draft.project,
            contract_value: Math.max(0, Math.round(draft.contractValue || 0)),
            contact_name: draft.contactName,
            contact_email: draft.contactEmail,
          })
          .select("id")
          .single(),
      );

      // The vendors_seed_compliance_items trigger writes the five rail rows, so
      // re-read rather than synthesising the shape client-side.
      const created = await loadVendorById(inserted.id);
      if (!created) throw new Error("Vendor was inserted but could not be read back");
      return created;
    },

    async listTasks() {
      const supabase = clientFactory();
      const rows = unwrap(
        await supabase
          .from("tasks")
          .select("*, vendors ( name )")
          .order("due_on", { ascending: true, nullsFirst: false }),
      ) as unknown as Array<{
        id: string;
        vendor_id: string | null;
        title: string;
        due_on: string | null;
        priority: TaskItem["priority"];
        status: TaskItem["status"];
        owner: string;
        vendors: { name: string } | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        vendorId: row.vendor_id,
        vendorName: row.vendors?.name ?? "Program-wide",
        dueOn: isoDate(row.due_on),
        priority: row.priority,
        status: row.status,
        owner: row.owner,
      }));
    },

    async listOverviewMetrics(): Promise<OverviewMetric[]> {
      const vendors = (await loadVendors()).map(toVendor);

      const projects = new Set(vendors.map((v) => v.project));
      const compliant = vendors.filter((v) => v.compliance.every((c) => c.status === "compliant"));
      const exceptions = vendors.flatMap((v) =>
        v.compliance.filter((c) => c.status !== "compliant"),
      );

      const horizon = new Date();
      horizon.setDate(horizon.getDate() + 30);
      const today = new Date().toISOString().slice(0, 10);
      const horizonIso = horizon.toISOString().slice(0, 10);

      const expiring = vendors.filter(
        (v) => v.expiresOn !== NO_EXPIRY && v.expiresOn >= today && v.expiresOn <= horizonIso,
      );
      const earliest = expiring
        .map((v) => v.expiresOn)
        .sort()
        .at(0);

      return [
        {
          id: "m1",
          label: "Vendors tracked",
          value: String(vendors.length),
          detail: `Across ${projects.size} active project${projects.size === 1 ? "" : "s"}`,
        },
        {
          id: "m2",
          label: "Fully compliant",
          value: String(compliant.length),
          detail: "All five rail items green",
        },
        {
          id: "m3",
          label: "Expiring in 30 days",
          value: String(expiring.length),
          detail: earliest ? `Earliest ${earliest}` : "Nothing lapsing this month",
        },
        {
          id: "m4",
          label: "Open exceptions",
          value: String(exceptions.length),
          detail: summariseExceptions(exceptions),
        },
      ];
    },

    async listReportRows(): Promise<ReportRow[]> {
      const supabase = clientFactory();
      const rows = unwrap(
        await supabase.from("company_report_rows").select("*").order("project"),
      ) as CompanyReportRowView[];

      return rows.map((row) => ({
        id: row.id,
        project: row.project,
        vendors: row.vendors,
        compliantPct: row.compliant_pct,
        expiringIn30: row.expiring_in_30,
        openExceptions: row.open_exceptions,
      }));
    },

    async listCompanies(): Promise<Company[]> {
      const supabase = clientFactory();
      const rows = unwrap(
        await supabase.from("admin_company_stats").select("*").order("name"),
      ) as AdminCompanyStatsView[];

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        plan: row.plan,
        vendors: row.vendor_count,
        seats: row.seat_count,
        complianceRate: row.compliance_rate,
        renewalOn: isoDate(row.subscription_renews_on),
      }));
    },

    async listQueue(): Promise<QueueItem[]> {
      const supabase = clientFactory();
      // Excludes 'resolved' on purpose: this page's own subtitle is
      // "awaiting reviewer action" - a resolved item's outcome is still
      // permanently on its row (resolveReviewItem() in documentReview.ts
      // writes resolution/resolution_note/resolved_at), it just no longer
      // belongs on the "what still needs a person" list.
      const rows = unwrap(
        await supabase
          .from("compliance_queue_items")
          .select("*, vendors ( name ), companies ( name )")
          .neq("state", "resolved")
          .order("submitted_on", { ascending: false }),
      ) as unknown as Array<{
        id: string;
        document_id: string | null;
        document_label: string;
        submitted_on: string;
        state: QueueItem["state"];
        vendors: { name: string } | null;
        companies: { name: string } | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        vendorName: row.vendors?.name ?? "Unknown vendor",
        company: row.companies?.name ?? "Unknown company",
        document: row.document_label,
        submittedOn: row.submitted_on,
        state: row.state,
      }));
    },

    async listLeads(): Promise<Lead[]> {
      const supabase = clientFactory();
      const rows = unwrap(
        await supabase.from("leads").select("*").order("created_on", { ascending: false }),
      ) as LeadRow[];

      return rows.map((row) => ({
        id: row.id,
        company: row.company_name,
        contact: row.contact_name,
        trade: row.trade,
        source: row.source,
        createdOn: row.created_on,
        stage: row.stage,
      }));
    },

    async listAccessGrants(): Promise<AccessGrant[]> {
      const supabase = clientFactory();
      const rows = unwrap(
        await supabase
          .from("company_members")
          .select("*, profiles ( email, full_name )")
          .order("created_at", { ascending: true }),
      ) as unknown as Array<{
        id: string;
        role: CompanyRole;
        scope: string;
        last_active_at: string | null;
        profiles: { email: string; full_name: string | null } | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        person: row.profiles?.full_name ?? row.profiles?.email ?? "Pending invitation",
        email: row.profiles?.email ?? "",
        role: ROLE_LABELS[row.role],
        scope: row.scope,
        lastActiveOn: row.last_active_at ? row.last_active_at.slice(0, 10) : "Never",
      }));
    },
  };
}

function summariseExceptions(items: ComplianceItem[]): string {
  const counts = items.reduce<Partial<Record<ComplianceStatus, number>>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});

  const parts = (["expired", "missing", "expiring", "pending"] as const)
    .filter((status) => counts[status])
    .map((status) => `${counts[status]} ${status}`);

  return parts.length > 0 ? parts.join(", ") : "No open exceptions";
}
