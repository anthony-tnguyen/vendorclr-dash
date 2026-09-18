import type {
  AccessGrant,
  ActivatedWorkspace,
  ActivationCode,
  ActivationCodeDraft,
  Company,
  ComplianceItem,
  DashboardRepository,
  Lead,
  OverviewMetric,
  QueueItem,
  ReportRow,
  TaskItem,
  Vendor,
  VendorDraft,
} from "./contracts";

/**
 * DEMO-ONLY in-memory repository. State lives for the lifetime of the tab and
 * is never written to a backend, database, mailbox or file store.
 */

const c = (
  key: ComplianceItem["key"],
  status: ComplianceItem["status"],
  effectiveDate: string | null,
  note?: string,
): ComplianceItem => ({ key, status, effectiveDate, note });

const vendors: Vendor[] = [
  {
    id: "vnd-1042",
    name: "Corbett Structural Steel",
    trade: "Structural Steel",
    project: "Harbor Point Tower B",
    contractValue: 4_820_000,
    contactName: "Dana Corbett",
    contactEmail: "dana@corbettsteel.example",
    policyNumber: "GL-8841-2266",
    expiresOn: "2026-11-30",
    certificateHolderName: "Halstead Builders",
    certificateHolderAddress: "500 Harbor Point Way, Boston, MA 02110",
    riskTier: "high",
    compliance: [
      c("coi", "compliant", "2026-11-30"),
      c("additionalInsured", "compliant", "2026-11-30"),
      c("waiverOfSubrogation", "compliant", "2026-11-30"),
      c("lienWaiver", "pending", "2026-08-25", "Conditional progress waiver in review"),
      c("renewal", "compliant", "2026-11-30"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 2_000_000, carried: 2_000_000 },
      { label: "Excess liability", required: 10_000_000, carried: 15_000_000 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
  {
    id: "vnd-1088",
    name: "Rivera Electrical Contractors",
    trade: "Electrical",
    project: "Harbor Point Tower B",
    contractValue: 2_140_000,
    contactName: "Manny Rivera",
    contactEmail: "manny@riveraelectric.example",
    policyNumber: "GL-2210-7741",
    expiresOn: "2026-09-14",
    certificateHolderName: "Halstead Builders",
    certificateHolderAddress: "500 Harbor Point Way, Boston, MA 02110",
    riskTier: "moderate",
    compliance: [
      c("coi", "expiring", "2026-09-14", "17 days to expiration"),
      c("additionalInsured", "compliant", "2026-09-14"),
      c("waiverOfSubrogation", "missing", null, "Endorsement not attached to COI"),
      c("lienWaiver", "compliant", "2026-08-01"),
      c("renewal", "expiring", "2026-09-14"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 2_000_000, carried: 2_000_000 },
      { label: "Auto liability", required: 1_000_000, carried: 500_000 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
  {
    id: "vnd-1131",
    name: "Northgate Mechanical",
    trade: "Mechanical / HVAC",
    project: "Cedar Ridge Medical",
    contractValue: 3_675_000,
    contactName: "Priya Anand",
    contactEmail: "priya@northgatemech.example",
    policyNumber: "GL-5590-1183",
    expiresOn: "2027-02-28",
    certificateHolderName: "Halstead Builders",
    certificateHolderAddress: "500 Harbor Point Way, Boston, MA 02110",
    riskTier: "moderate",
    compliance: [
      c("coi", "compliant", "2027-02-28"),
      c("additionalInsured", "compliant", "2027-02-28"),
      c("waiverOfSubrogation", "compliant", "2027-02-28"),
      c("lienWaiver", "compliant", "2026-08-05"),
      c("renewal", "compliant", "2027-02-28"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 2_000_000, carried: 4_000_000 },
      { label: "Pollution liability", required: 1_000_000, carried: 1_000_000 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
  {
    id: "vnd-1177",
    name: "Delgado Concrete Works",
    trade: "Concrete",
    project: "Cedar Ridge Medical",
    contractValue: 1_960_000,
    contactName: "Sofia Delgado",
    contactEmail: "sofia@delgadoconcrete.example",
    policyNumber: "GL-3320-9014",
    expiresOn: "2026-07-31",
    // Deliberately wrong, unlike every other demo vendor - the certificate
    // names a different client entirely. Shows what this field is actually
    // for: catching a vendor whose broker never updated who the coverage is
    // supposed to protect, not just confirming coverage exists.
    certificateHolderName: "ABC General Contractors",
    certificateHolderAddress: "88 Industrial Pkwy, Providence, RI 02903",
    riskTier: "high",
    compliance: [
      c("coi", "expired", "2026-07-31", "Certificate lapsed 28 days ago"),
      c("additionalInsured", "expired", "2026-07-31"),
      c("waiverOfSubrogation", "missing", null),
      c("lienWaiver", "missing", null),
      c("renewal", "expired", "2026-07-31"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 2_000_000, carried: 1_000_000 },
      { label: "Excess liability", required: 5_000_000, carried: 0 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
  {
    id: "vnd-1204",
    name: "Summit Earthworks",
    trade: "Earthwork",
    project: "Route 9 Interchange",
    contractValue: 5_310_000,
    contactName: "Grant Whitley",
    contactEmail: "grant@summitearth.example",
    policyNumber: "GL-7712-4408",
    expiresOn: "2026-12-31",
    certificateHolderName: "Halstead Builders",
    certificateHolderAddress: "500 Harbor Point Way, Boston, MA 02110",
    riskTier: "moderate",
    compliance: [
      c("coi", "compliant", "2026-12-31"),
      c("additionalInsured", "pending", "2026-08-22", "Blanket AI endorsement submitted"),
      c("waiverOfSubrogation", "compliant", "2026-12-31"),
      c("lienWaiver", "compliant", "2026-08-10"),
      c("renewal", "compliant", "2026-12-31"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 2_000_000, carried: 2_000_000 },
      { label: "Auto liability", required: 2_000_000, carried: 2_000_000 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
  {
    id: "vnd-1250",
    name: "Beacon Roofing Systems",
    trade: "Roofing",
    project: "Route 9 Interchange",
    contractValue: 880_000,
    contactName: "Tara Osei",
    contactEmail: "tara@beaconroof.example",
    policyNumber: "GL-1194-6620",
    expiresOn: "2026-10-05",
    certificateHolderName: "Halstead Builders",
    certificateHolderAddress: "500 Harbor Point Way, Boston, MA 02110",
    riskTier: "low",
    compliance: [
      c("coi", "compliant", "2026-10-05"),
      c("additionalInsured", "compliant", "2026-10-05"),
      c("waiverOfSubrogation", "compliant", "2026-10-05"),
      c("lienWaiver", "pending", "2026-08-19"),
      c("renewal", "expiring", "2026-10-05"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 1_000_000, carried: 2_000_000 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
  {
    id: "vnd-1293",
    name: "Clearline Glazing",
    trade: "Glazing",
    project: "Harbor Point Tower B",
    contractValue: 1_420_000,
    contactName: "Ben Hollis",
    contactEmail: "ben@clearlineglazing.example",
    policyNumber: "GL-6603-3357",
    expiresOn: "2026-09-30",
    certificateHolderName: "Halstead Builders",
    certificateHolderAddress: "500 Harbor Point Way, Boston, MA 02110",
    riskTier: "low",
    compliance: [
      c("coi", "compliant", "2026-09-30"),
      c("additionalInsured", "compliant", "2026-09-30"),
      c("waiverOfSubrogation", "pending", "2026-08-21"),
      c("lienWaiver", "compliant", "2026-08-02"),
      c("renewal", "expiring", "2026-09-30"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 1_000_000, carried: 1_000_000 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
  {
    id: "vnd-1318",
    name: "Ironclad Fire Protection",
    trade: "Fire Protection",
    project: "Cedar Ridge Medical",
    contractValue: 1_105_000,
    contactName: "Alice Nowak",
    contactEmail: "alice@ironcladfp.example",
    policyNumber: "GL-4487-2290",
    expiresOn: "2027-01-15",
    certificateHolderName: "Halstead Builders",
    certificateHolderAddress: "500 Harbor Point Way, Boston, MA 02110",
    riskTier: "low",
    compliance: [
      c("coi", "compliant", "2027-01-15"),
      c("additionalInsured", "compliant", "2027-01-15"),
      c("waiverOfSubrogation", "compliant", "2027-01-15"),
      c("lienWaiver", "compliant", "2026-08-12"),
      c("renewal", "compliant", "2027-01-15"),
    ],
    limits: [
      { label: "General liability / occurrence", required: 2_000_000, carried: 2_000_000 },
      { label: "Workers compensation", required: 1_000_000, carried: 1_000_000 },
    ],
  },
];

const tasks: TaskItem[] = [
  {
    id: "tsk-401",
    title: "Request replacement COI after lapse",
    vendorId: "vnd-1177",
    vendorName: "Delgado Concrete Works",
    dueOn: "2026-08-29",
    priority: "high",
    status: "open",
    owner: "R. Sandoval",
  },
  {
    id: "tsk-402",
    title: "Collect waiver of subrogation endorsement",
    vendorId: "vnd-1088",
    vendorName: "Rivera Electrical Contractors",
    dueOn: "2026-09-02",
    priority: "high",
    status: "open",
    owner: "R. Sandoval",
  },
  {
    id: "tsk-403",
    title: "Confirm auto liability limit meets $1,000,000",
    vendorId: "vnd-1088",
    vendorName: "Rivera Electrical Contractors",
    dueOn: "2026-09-05",
    priority: "medium",
    status: "waiting",
    owner: "K. Lieu",
  },
  {
    id: "tsk-404",
    title: "Review blanket additional insured endorsement",
    vendorId: "vnd-1204",
    vendorName: "Summit Earthworks",
    dueOn: "2026-09-09",
    priority: "medium",
    status: "waiting",
    owner: "K. Lieu",
  },
  {
    id: "tsk-405",
    title: "Log conditional progress lien waiver",
    vendorId: "vnd-1042",
    vendorName: "Corbett Structural Steel",
    dueOn: "2026-09-12",
    priority: "low",
    status: "open",
    owner: "M. Boyle",
  },
  {
    id: "tsk-406",
    title: "Close out renewal cycle for Q3 roofing scopes",
    vendorId: "vnd-1250",
    vendorName: "Beacon Roofing Systems",
    dueOn: "2026-08-20",
    priority: "low",
    status: "done",
    owner: "M. Boyle",
  },
];

const metrics: OverviewMetric[] = [
  { id: "m1", label: "Vendors tracked", value: "8", detail: "Across 3 active projects" },
  { id: "m2", label: "Fully compliant", value: "4", detail: "All five rail items green" },
  { id: "m3", label: "Expiring in 30 days", value: "3", detail: "Earliest 2026-09-14" },
  { id: "m4", label: "Open exceptions", value: "6", detail: "2 expired, 3 missing, 1 limit gap" },
];

const reportRows: ReportRow[] = [
  {
    id: "rpt-1",
    project: "Harbor Point Tower B",
    vendors: 3,
    compliantPct: 67,
    expiringIn30: 2,
    openExceptions: 2,
  },
  {
    id: "rpt-2",
    project: "Cedar Ridge Medical",
    vendors: 3,
    compliantPct: 67,
    expiringIn30: 0,
    openExceptions: 3,
  },
  {
    id: "rpt-3",
    project: "Route 9 Interchange",
    vendors: 2,
    compliantPct: 50,
    expiringIn30: 1,
    openExceptions: 1,
  },
];

const companies: Company[] = [
  {
    id: "co-11",
    name: "Halstead Builders",
    plan: "Enterprise",
    vendors: 214,
    seats: 32,
    complianceRate: 91,
    renewalOn: "2027-03-01",
  },
  {
    id: "co-12",
    name: "Marrow Construction Group",
    plan: "Program",
    vendors: 88,
    seats: 12,
    complianceRate: 84,
    renewalOn: "2026-11-15",
  },
  {
    id: "co-13",
    name: "Talbot Civil",
    plan: "Field",
    vendors: 31,
    seats: 5,
    complianceRate: 72,
    renewalOn: "2026-10-01",
  },
  {
    id: "co-14",
    name: "Ridgeway Interiors",
    plan: "Field",
    vendors: 19,
    seats: 4,
    complianceRate: 96,
    renewalOn: "2027-01-20",
  },
];

const queue: QueueItem[] = [
  {
    id: "q-501",
    vendorName: "Delgado Concrete Works",
    company: "Halstead Builders",
    document: "Certificate of insurance",
    submittedOn: "2026-08-27",
    state: "escalated",
  },
  {
    id: "q-502",
    vendorName: "Summit Earthworks",
    company: "Talbot Civil",
    document: "Blanket AI endorsement",
    submittedOn: "2026-08-22",
    state: "in-review",
  },
  {
    id: "q-503",
    vendorName: "Clearline Glazing",
    company: "Halstead Builders",
    document: "Waiver of subrogation",
    submittedOn: "2026-08-21",
    state: "queued",
  },
  {
    id: "q-504",
    vendorName: "Beacon Roofing Systems",
    company: "Marrow Construction Group",
    document: "Conditional lien waiver",
    submittedOn: "2026-08-19",
    state: "queued",
  },
];

const leads: Lead[] = [
  {
    id: "ld-71",
    company: "Kestrel Design Build",
    contact: "Nina Park",
    trade: "General contractor",
    source: "Referral",
    createdOn: "2026-08-26",
    stage: "qualified",
  },
  {
    id: "ld-72",
    company: "Bay Line Utilities",
    contact: "Omar Haddad",
    trade: "Underground utilities",
    source: "Trade show",
    createdOn: "2026-08-24",
    stage: "new",
  },
  {
    id: "ld-73",
    company: "Fielder & Sons Paving",
    contact: "Jo Fielder",
    trade: "Paving",
    source: "Website",
    createdOn: "2026-08-18",
    stage: "demo",
  },
  {
    id: "ld-74",
    company: "Arbor Heights Homes",
    contact: "Renee Vaughn",
    trade: "Residential",
    source: "Outbound",
    createdOn: "2026-08-11",
    stage: "closed",
  },
];

const accessGrants: AccessGrant[] = [
  {
    id: "ac-1",
    person: "Rosa Sandoval",
    email: "rosa@halstead.example",
    role: "Risk Manager",
    scope: "All projects",
    lastActiveOn: "2026-08-28",
  },
  {
    id: "ac-2",
    person: "Kenji Lieu",
    email: "kenji@halstead.example",
    role: "Project Engineer",
    scope: "Harbor Point Tower B",
    lastActiveOn: "2026-08-27",
  },
  {
    id: "ac-3",
    person: "Maureen Boyle",
    email: "maureen@halstead.example",
    role: "Owner",
    scope: "All projects",
    lastActiveOn: "2026-08-25",
  },
  {
    id: "ac-4",
    person: "Ty Nakamura",
    email: "ty@halstead.example",
    role: "Read only",
    scope: "Reports",
    lastActiveOn: "2026-08-14",
  },
];


/**
 * Sample activation codes for the preview's staff screen. These are display
 * content only: nothing here is a code anyone could redeem, because the demo
 * repository has no database to redeem against - see redeemActivationCode().
 */
const DEMO_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";

const demoCode = (): string =>
  Array.from(
    { length: 10 },
    () => DEMO_CODE_ALPHABET[Math.floor(Math.random() * DEMO_CODE_ALPHABET.length)],
  ).join("");

const activationCodes: ActivationCode[] = [
  {
    id: "act-1",
    code: "K7M2QP9XRD",
    email: "founder@halstead.example",
    companyName: "Halstead Builders",
    plan: "Program",
    status: "pending",
    renewsOn: "2027-03-01",
    note: "Design partner - annual.",
    createdOn: "2026-09-10",
    usedOn: null,
  },
  {
    id: "act-2",
    code: "HPQ4WKCY8M",
    email: "ops@marrow.example",
    companyName: "Marrow Construction Group",
    plan: "Field",
    status: "used",
    renewsOn: null,
    note: null,
    createdOn: "2026-08-19",
    usedOn: "2026-08-24",
  },
];

const delay = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 120));

export function createDemoRepository(): DashboardRepository {
  const vendorStore = vendors.map((v) => ({ ...v }));
  const codeStore = activationCodes.map((r) => ({ ...r }));

  return {
    listVendors: () => delay(vendorStore.map((v) => ({ ...v }))),
    getVendor: (vendorId) => delay(vendorStore.find((v) => v.id === vendorId) ?? null),
    createVendor: (draft: VendorDraft) => {
      const vendor: Vendor = {
        id: `vnd-${1400 + vendorStore.length}`,
        name: draft.name,
        trade: draft.trade,
        project: draft.project,
        contractValue: draft.contractValue,
        contactName: draft.contactName,
        contactEmail: draft.contactEmail,
        policyNumber: "PENDING",
        expiresOn: "—",
        certificateHolderName: "Not on file",
        certificateHolderAddress: "Not on file",
        riskTier: "moderate",
        compliance: [
          c("coi", "missing", null),
          c("additionalInsured", "missing", null),
          c("waiverOfSubrogation", "missing", null),
          c("lienWaiver", "missing", null),
          c("renewal", "missing", null),
        ],
        limits: [],
      };
      vendorStore.unshift(vendor);
      return delay(vendor);
    },
    listTasks: () => delay(tasks.map((t) => ({ ...t }))),
    listOverviewMetrics: () => delay(metrics.map((m) => ({ ...m }))),
    listReportRows: () => delay(reportRows.map((r) => ({ ...r }))),
    listCompanies: () => delay(companies.map((r) => ({ ...r }))),
    listQueue: () => delay(queue.map((r) => ({ ...r }))),
    listLeads: () => delay(leads.map((r) => ({ ...r }))),
    listAccessGrants: () => delay(accessGrants.map((r) => ({ ...r }))),

    // Activation codes. The staff-side screens can be walked through against
    // this in-memory store, which is what the preview and the Vitest suite need.
    // The two operations that a database is the whole point of deliberately
    // refuse rather than return something plausible - a demo that pretended to
    // create a company, or to close one, would be exactly the fake success this
    // app's copy rules forbid.
    listActivationCodes: () => delay(codeStore.map((r) => ({ ...r }))),
    createActivationCode: (draft: ActivationCodeDraft) => {
      const record: ActivationCode = {
        id: `act-${1400 + codeStore.length}`,
        code: demoCode(),
        email: draft.email.trim().toLowerCase(),
        companyName: draft.companyName,
        plan: draft.plan,
        status: "pending",
        renewsOn: draft.renewsOn ?? null,
        note: draft.note ?? null,
        createdOn: new Date().toISOString().slice(0, 10),
        usedOn: null,
      };
      codeStore.unshift(record);
      return delay({ ...record });
    },
    revokeActivationCode: (codeId: string) => {
      const record = codeStore.find((r) => r.id === codeId);
      if (!record) return Promise.reject(new Error("Activation code not found"));
      if (record.status !== "pending") {
        return Promise.reject(new Error("Only a pending activation code can be revoked"));
      }
      record.status = "revoked";
      return delay({ ...record });
    },
    redeemActivationCode: (): Promise<ActivatedWorkspace> =>
      Promise.reject(
        new Error("Demo mode: activation codes are not checked or redeemed without a database."),
      ),
    setCompanyActivation: (): Promise<void> =>
      Promise.reject(new Error("Demo mode: there is no company here to activate or close.")),
  };
}
