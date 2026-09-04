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
  dashboard: "/dashboard",
  vendors: "/dashboard/vendors",
  vendorDetail: "/dashboard/vendors/$vendorId",
  tasks: "/dashboard/tasks",
  reports: "/dashboard/reports",
  settings: "/dashboard/settings",
  adminOverview: "/dashboard/admin",
  adminCompanies: "/dashboard/admin/companies",
  adminCompliance: "/dashboard/admin/compliance",
  adminLeads: "/dashboard/admin/leads",
  adminAccess: "/dashboard/admin/access",
} as const;

export interface NavItem {
  label: string;
  to: string;
  description: string;
}

export const customerNav = [
  { label: "Command center", to: routes.dashboard, description: "Compliance priorities and KPIs" },
  { label: "Vendors", to: routes.vendors, description: "Vendor roster and compliance rail" },
  { label: "Tasks", to: routes.tasks, description: "Open compliance follow-ups" },
  { label: "Reports", to: routes.reports, description: "Project level compliance reporting" },
  { label: "Settings", to: routes.settings, description: "Requirement defaults and contacts" },
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
] as const satisfies readonly NavItem[];
