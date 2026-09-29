/**
 * Route map and navigation model.
 *
 * Routing itself is file-based (TanStack Router generates the tree from
 * src/routes). This module is the single place that names paths and the
 * sidebar structure so pages and tests stay in sync.
 */

export const routes = {
  login: "/login",
  signup: "/signup",
  resetPassword: "/reset-password",
  /** Read-only sample console for accounts that have not been activated yet. */
  demo: "/demo",
  /** Plan selection + Stripe self-checkout for a signed-in account with no workspace. */
  checkout: "/checkout",
  /** Post-checkout onboarding wizard, shown until service_status reaches 'live'. */
  onboarding: "/onboarding",
  /** Public link a teammate receives by email. Not in customerNav - nothing in-app links to it. */
  acceptInvite: "/accept-invite/$token",
  dashboard: "/dashboard",
  vendors: "/dashboard/vendors",
  vendorDetail: "/dashboard/vendors/$vendorId",
  /** Bulk CSV onboarding. Reached from the Vendors page, not the sidebar. */
  vendorImport: "/dashboard/vendors/import",
  /** COI-driven vendor intake. Reached from the Vendors page and onboarding, not the sidebar. */
  vendorCoiImport: "/dashboard/vendors/coi-import",
  tasks: "/dashboard/tasks",
  reports: "/dashboard/reports",
  projects: "/dashboard/projects",
  projectDetail: "/dashboard/projects/$projectId",
  requirementProfiles: "/dashboard/requirement-profiles",
  settings: "/dashboard/settings",
  team: "/dashboard/team",
  adminOverview: "/dashboard/admin",
  adminCompanies: "/dashboard/admin/companies",
  adminCompliance: "/dashboard/admin/compliance",
  adminLeads: "/dashboard/admin/leads",
  adminAccess: "/dashboard/admin/access",
  adminActivation: "/dashboard/admin/activation",
  adminOperations: "/dashboard/admin/operations",
  help: "/dashboard/help",
  /** Public, signed-out pages linked from auth, the vendor portal and the console footer. */
  terms: "/terms",
  privacy: "/privacy",
} as const;

export interface NavItem {
  label: string;
  to: string;
  description: string;
}

export const customerNav = [
  { label: "Overview", to: routes.dashboard, description: "Compliance priorities and status" },
  { label: "Vendors", to: routes.vendors, description: "Vendor roster and compliance rail" },
  { label: "Projects", to: routes.projects, description: "Project assignments and requirements" },
  { label: "Tasks", to: routes.tasks, description: "Open compliance follow-ups" },
  { label: "Reports", to: routes.reports, description: "Project level compliance reporting" },
  { label: "Settings", to: routes.settings, description: "Requirement defaults and contacts" },
  { label: "Team", to: routes.team, description: "Teammate roles and access" },
  { label: "Help", to: routes.help, description: "FAQ and how VendorClr works" },
] as const satisfies readonly NavItem[];

export const adminNav = [
  { label: "Review queue", to: routes.adminOverview, description: "Priority document decisions" },
  { label: "Companies", to: routes.adminCompanies, description: "Customer accounts" },
  {
    label: "Compliance queue",
    to: routes.adminCompliance,
    description: "Documents awaiting review",
  },
  { label: "Leads", to: routes.adminLeads, description: "Inbound pipeline" },
  { label: "Access", to: routes.adminAccess, description: "Role and scope management" },
  {
    label: "Activation codes",
    to: routes.adminActivation,
    description: "Codes that open a paid workspace",
  },
  {
    label: "Operations",
    to: routes.adminOperations,
    description: "Failed jobs, stale reviews and delivery problems",
  },
  { label: "Help", to: routes.help, description: "FAQ and how VendorClr works" },
] as const satisfies readonly NavItem[];
