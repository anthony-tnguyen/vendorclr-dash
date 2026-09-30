import type {
  AccessGrant,
  ActivatedWorkspace,
  ActivationCode,
  ActivationCodeDraft,
  Company,
  ComplianceItem,
  ComplianceKey,
  ComplianceStatus,
  CoverageLimit,
  DashboardRepository,
  Lead,
  OnboardingPatch,
  OnboardingReview,
  OnboardingState,
  QueueItem,
  ReportRow,
  TaskItem,
  Vendor,
  VendorDraft,
  VendorTrade,
  VendorUsage,
} from "./contracts";
import type {
  ActivationCodeRow,
  AdminCompanyStatsView,
  CompanyPlan,
  CompanyReportRowView,
  CompanyRole,
  CompanyServiceStatus,
  ComplianceRequirementRow,
  LeadRow,
  RedeemedCompanyRow,
  VendorComplianceItemRow,
  VendorPolicyRow,
  VendorRow,
} from "./dbTypeAliases";
import { getSupabaseClient, type VendorClrClient } from "@/lib/supabase/client";
import { readSupabaseEnv } from "@/lib/supabase/env";

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
const NO_CERTIFICATE_HOLDER = "Not on file";

export interface VendorWithChildren extends VendorRow {
  vendor_policies: VendorPolicyRow[];
  vendor_compliance_items: VendorComplianceItemRow[];
}

const VENDOR_SELECT = `
  *,
  vendor_policies (*),
  vendor_compliance_items (*)
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

/**
 * Pairs each of the company's requirements with what this specific vendor
 * actually carries, read live from their own active policies - never a
 * second, independently-maintained number. A requirement with no matching
 * active policy of its policy_type (the vendor doesn't carry that coverage
 * at all, or only an expired/superseded one) carries 0, same as "missing"
 * reads everywhere else in this schema; it is never silently omitted from
 * the comparison just because there's nothing to show.
 */
export function toCoverageLimits(
  requirements: ComplianceRequirementRow[],
  policies: VendorPolicyRow[],
): CoverageLimit[] {
  const activeByType = new Map(
    policies.filter((p) => p.status === "active").map((p) => [p.policy_type, p]),
  );

  return [...requirements]
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
    .map((req) => {
      const policy = activeByType.get(req.policy_type);
      const carried = policy?.[req.limit_field] ?? 0;
      return { label: req.label, required: req.required_amount, carried };
    });
}

export function toVendor(
  row: VendorWithChildren,
  requirements: ComplianceRequirementRow[],
): Vendor {
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
    certificateHolderName: policy?.certificate_holder_name || NO_CERTIFICATE_HOLDER,
    certificateHolderAddress: policy?.certificate_holder_address || NO_CERTIFICATE_HOLDER,
    riskTier: row.risk_tier,
    compliance: toComplianceItems(row.vendor_compliance_items ?? []),
    limits: toCoverageLimits(requirements, row.vendor_policies ?? []),
  };
}

function isoDate(value: string | null): string {
  return value ?? NO_EXPIRY;
}

function toActivationCode(row: ActivationCodeRow): ActivationCode {
  return {
    id: row.id,
    code: row.code,
    email: row.email,
    companyName: row.company_name,
    plan: row.plan,
    status: row.status,
    renewsOn: row.renews_on,
    note: row.note,
    createdOn: row.created_at.slice(0, 10),
    usedOn: row.used_at,
  };
}

/**
 * Calls a Supabase Edge Function with the caller's access token attached
 * explicitly.
 *
 * We do NOT use supabase.functions.invoke(): with the @supabase/ssr browser
 * client and the new publishable API key, invoke() does not reliably forward the
 * logged-in user's JWT (it was observed sending only the `apikey` header and no
 * `Authorization`, so the function's getUser() saw no user and returned 401).
 * A direct fetch removes that ambiguity — we read the current session, require
 * it, and set Authorization ourselves. No session throws a clear "sign in"
 * error rather than surfacing an opaque 401.
 */
async function invokeEdgeFunction<T>(
  supabase: VendorClrClient,
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const env = readSupabaseEnv();
  if (!env) throw new Error("Supabase is not configured.");
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) {
    throw new Error("Your session has expired. Please sign in again and retry.");
  }

  const res = await fetch(`${env.url}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.anonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const message = (parsed as { error?: string } | null)?.error;
    throw new Error(message || `Request failed (${res.status}).`);
  }
  return parsed as T;
}

/** The company_onboarding columns embedded into the staff review query. */
interface OnboardingEmbed {
  current_step: number;
  company_info: Record<string, unknown> | null;
  program: Record<string, unknown> | null;
  projects: Record<string, unknown> | null;
  requirements: Record<string, unknown> | null;
  submitted_at: string | null;
  reviewed_at: string | null;
}

export function createSupabaseRepository(
  clientFactory: () => VendorClrClient = getSupabaseClient,
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
            "Signed-in user belongs to no company. Accounts start on the demo screen and get a workspace when an activation code is redeemed (see /demo); this user has none.",
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

  // Company-wide, not vendor-scoped (see migration 13's docblock) - fetched
  // once per call rather than embedded per vendor row, since PostgREST can
  // only auto-embed across a declared FK and compliance_requirements has
  // none pointing at vendors. RLS already scopes this to the caller's own
  // company/companies with no explicit filter, same as vendor_policies (*)
  // above.
  async function loadRequirements(): Promise<ComplianceRequirementRow[]> {
    const supabase = clientFactory();
    return unwrap(
      await supabase
        .from("compliance_requirements")
        .select("*")
        .order("sort_order", { ascending: true }),
    );
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
    if (!result.data) return null;

    const requirements = await loadRequirements();
    return toVendor(result.data, requirements);
  }

  return {
    async listVendors() {
      const [vendors, requirements] = await Promise.all([loadVendors(), loadRequirements()]);
      return vendors.map((v) => toVendor(v, requirements));
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
      // Two queries, not a PostgREST embed (`profiles ( email, full_name )`
      // off company_members): there is no FK from company_members to
      // profiles - both independently reference auth.users - so PostgREST
      // has no relationship to embed through. That embed would fail every
      // call with PGRST200 ("no relationship found" - confirmed live, not a
      // guess; see fetchOwnerEmails()'s docblock in vendorUploadRequests.ts
      // for the same mistake caught elsewhere), which unwrap() turns into a
      // thrown error - this screen has never successfully loaded live data.
      const members = unwrap(
        await supabase
          .from("company_members")
          .select("id, user_id, role, scope, last_active_at")
          .order("created_at", { ascending: true }),
      ) as Array<{
        id: string;
        user_id: string;
        role: CompanyRole;
        scope: string;
        last_active_at: string | null;
      }>;

      const userIds = [...new Set(members.map((m) => m.user_id))];
      const profileRows =
        userIds.length === 0
          ? []
          : unwrap(
              await supabase.from("profiles").select("id, email, full_name").in("id", userIds),
            );
      const profileById = new Map(
        (profileRows as Array<{ id: string; email: string; full_name: string | null }>).map((p) => [
          p.id,
          p,
        ]),
      );

      return members.map((row) => {
        const profile = profileById.get(row.user_id);
        return {
          id: row.id,
          person: profile?.full_name ?? profile?.email ?? "Pending invitation",
          email: profile?.email ?? "",
          role: ROLE_LABELS[row.role],
          scope: row.scope,
          lastActiveOn: row.last_active_at ? row.last_active_at.slice(0, 10) : "Never",
        };
      });
    },

    // ---------------------------------------------------------------------
    // Activation codes (supabase/migrations/20260918000200_activation_codes.sql)
    //
    // Every write here is a SECURITY DEFINER RPC, never a direct insert or
    // update: activation_codes has a SELECT policy for staff and deliberately no
    // write policy at all, so RLS refuses a direct write from any role, and the
    // role/email checks that matter live inside the functions. Nothing below
    // resolves a company first, because redemption is what creates one.
    // ---------------------------------------------------------------------

    async listActivationCodes(): Promise<ActivationCode[]> {
      const supabase = clientFactory();
      const rows = unwrap(
        await supabase
          .from("activation_codes")
          .select("*")
          .order("created_at", { ascending: false }),
      ) as ActivationCodeRow[];

      return rows.map(toActivationCode);
    },

    async createActivationCode(draft: ActivationCodeDraft): Promise<ActivationCode> {
      const supabase = clientFactory();
      const row = unwrap(
        await supabase.rpc("create_activation_code", {
          target_email: draft.email,
          target_company: draft.companyName,
          target_plan: draft.plan,
          renews_on: draft.renewsOn ?? null,
          note: draft.note ?? null,
        }),
      ) as ActivationCodeRow;

      return toActivationCode(row);
    },

    async revokeActivationCode(codeId: string): Promise<ActivationCode> {
      const supabase = clientFactory();
      const row = unwrap(
        await supabase.rpc("revoke_activation_code", { target_code: codeId }),
      ) as ActivationCodeRow;

      return toActivationCode(row);
    },

    async redeemActivationCode(code: string): Promise<ActivatedWorkspace> {
      const supabase = clientFactory();
      // The failure message is the database's own, deliberately uniform ("That
      // code was not recognised.") for unknown, other-person's, already-used and
      // revoked codes alike, so the form cannot be used to probe which codes
      // exist. Pass it through rather than replacing it with a generic one.
      const row = unwrap(
        await supabase.rpc("redeem_activation_code", { entered_code: code }),
      ) as RedeemedCompanyRow;

      return { companyId: row.id, companyName: row.name, plan: row.plan };
    },

    async setCompanyActivation(
      companyId: string,
      activation: "demo" | "activated" | "revoked",
    ): Promise<void> {
      const supabase = clientFactory();
      unwrap(
        await supabase.rpc("set_company_activation", {
          target_company: companyId,
          next_status: activation,
        }),
      );
    },

    async createCheckoutSession(plan): Promise<{ url: string }> {
      const supabase = clientFactory();
      // The Stripe secret never leaves the create-checkout Edge Function; this
      // only forwards the caller's access token so the function can identify them.
      const data = await invokeEdgeFunction<{ url?: string }>(supabase, "create-checkout", {
        plan,
      });
      if (!data?.url) throw new Error("Checkout did not return a URL.");
      return { url: data.url };
    },

    async createBillingPortalSession(): Promise<{ url: string }> {
      const supabase = clientFactory();
      const data = await invokeEdgeFunction<{ url?: string }>(supabase, "billing-portal", {});
      if (!data?.url) throw new Error("Billing portal did not return a URL.");
      return { url: data.url };
    },

    async getOnboarding(): Promise<OnboardingState | null> {
      const supabase = clientFactory();
      const companyId = await resolveCompanyId();
      const { data, error } = await supabase
        .from("company_onboarding")
        .select(
          "current_step, company_info, program, projects, requirements, submitted_at, reviewed_at",
        )
        .eq("company_id", companyId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const row = data as {
        current_step: number;
        company_info: Record<string, unknown> | null;
        program: Record<string, unknown> | null;
        projects: Record<string, unknown> | null;
        requirements: Record<string, unknown> | null;
        submitted_at: string | null;
        reviewed_at: string | null;
      };
      return {
        currentStep: row.current_step,
        companyInfo: row.company_info ?? {},
        program: row.program ?? {},
        projects: row.projects ?? {},
        requirements: row.requirements ?? {},
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
      };
    },

    async saveOnboarding(patch: OnboardingPatch): Promise<void> {
      const supabase = clientFactory();
      const companyId = await resolveCompanyId();
      const row: Record<string, unknown> = { company_id: companyId };
      if (patch.currentStep !== undefined) row["current_step"] = patch.currentStep;
      if (patch.companyInfo !== undefined) row["company_info"] = patch.companyInfo;
      if (patch.program !== undefined) row["program"] = patch.program;
      if (patch.projects !== undefined) row["projects"] = patch.projects;
      if (patch.requirements !== undefined) row["requirements"] = patch.requirements;
      // A write with no `.select()` returns `data: null`, so check `error`
      // directly rather than unwrap() (which throws on null data even on success).
      const { error } = await supabase
        .from("company_onboarding")
        .upsert(row, { onConflict: "company_id" });
      if (error) throw new Error(error.message);
    },

    async submitOnboarding(): Promise<void> {
      const supabase = clientFactory();
      const companyId = await resolveCompanyId();
      unwrap(await supabase.rpc("submit_company_onboarding", { target_company: companyId }));
    },

    async getVendorUsage(): Promise<VendorUsage> {
      const supabase = clientFactory();
      const companyId = await resolveCompanyId();
      const rows = unwrap(
        await supabase.rpc("company_vendor_usage", { target_company: companyId }),
      ) as
        | Array<{ active_vendors: number; max_active_vendors: number | null; utilization: number }>
        | { active_vendors: number; max_active_vendors: number | null; utilization: number }
        | null;
      // A TABLE-returning function comes back as an array; be tolerant of either.
      const row = Array.isArray(rows) ? rows[0] : rows;
      return {
        activeVendors: row?.active_vendors ?? 0,
        maxActiveVendors: row?.max_active_vendors ?? null,
        utilization: Number(row?.utilization ?? 0),
      };
    },

    async listOnboardingReviews(): Promise<OnboardingReview[]> {
      const supabase = clientFactory();
      // Staff-only in effect: companies RLS returns other companies' rows only
      // to is_platform_admin(), and company_onboarding is embedded through the
      // same gate. A non-staff caller sees at most their own row (which is not
      // what this screen is for) - the AdminGuard hides it from them anyway.
      const rows = unwrap(
        await supabase
          .from("companies")
          .select(
            "id, name, plan, service_status, created_at, company_onboarding ( current_step, company_info, program, projects, requirements, submitted_at, reviewed_at )",
          )
          .in("service_status", ["onboarding", "in_review"])
          .order("created_at", { ascending: true }),
      ) as Array<{
        id: string;
        name: string;
        plan: CompanyPlan;
        service_status: CompanyServiceStatus;
        created_at: string;
        company_onboarding: OnboardingEmbed | OnboardingEmbed[] | null;
      }>;

      // Active-vendor counts come from the admin stats view (vendor_count is
      // non-archived vendors) rather than N calls to company_vendor_usage().
      const ids = rows.map((row) => row.id);
      const vendorCountById = new Map<string, number>();
      if (ids.length > 0) {
        const stats = unwrap(
          await supabase.from("admin_company_stats").select("id, vendor_count").in("id", ids),
        ) as Array<{ id: string; vendor_count: number }>;
        for (const stat of stats) vendorCountById.set(stat.id, stat.vendor_count);
      }

      return rows.map((row) => {
        const ob = Array.isArray(row.company_onboarding)
          ? (row.company_onboarding[0] ?? null)
          : row.company_onboarding;
        return {
          companyId: row.id,
          companyName: row.name,
          plan: row.plan,
          serviceStatus: row.service_status,
          currentStep: ob?.current_step ?? 1,
          companyInfo: ob?.company_info ?? {},
          program: ob?.program ?? {},
          projects: ob?.projects ?? {},
          requirements: ob?.requirements ?? {},
          activeVendors: vendorCountById.get(row.id) ?? 0,
          submittedAt: ob?.submitted_at ?? null,
          reviewedAt: ob?.reviewed_at ?? null,
          createdAt: row.created_at,
        };
      });
    },

    async setCompanyServiceStatus(
      companyId: string,
      status: "onboarding" | "in_review" | "live",
    ): Promise<void> {
      const supabase = clientFactory();
      unwrap(
        await supabase.rpc("set_company_service_status", {
          target_company: companyId,
          next_status: status,
        }),
      );
    },
  };
}
