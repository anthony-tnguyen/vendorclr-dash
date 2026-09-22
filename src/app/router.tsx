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
  dashboard: "/dashboard",
  vendors: "/dashboard/vendors",
  vendorDetail: "/dashboard/vendors/$vendorId",
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
} as const;

export interface NavItem {
  label: string;
  to: string;
  description: string;
}

export const customerNav = [
  { label: "Command center", to: routes.dashboard, description: "Compliance priorities and KPIs" },
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
