import type { CompanyMemberRole } from "@/workflows/companyInvitations";

/**
 * The one role vocabulary for company membership and invitations alike —
 * mirrors the `role` check constraint on both company_members and
 * company_invitations in supabase/migrations/20260916000500_company_member_invitations.sql.
 * Do not add a role here that isn't in that constraint, and don't invent a
 * second role model elsewhere in the UI.
 */
export const ROLE_OPTIONS: Array<{ value: CompanyMemberRole; label: string; blurb: string }> = [
  { value: "owner", label: "Owner", blurb: "Full control, including who has access." },
  {
    value: "risk_manager",
    label: "Risk manager",
    blurb: "Sets insurance requirements and reviews compliance.",
  },
  {
    value: "project_engineer",
    label: "Project engineer",
    blurb: "Works vendors and documents on projects.",
  },
  { value: "read_only", label: "Read only", blurb: "Can view, cannot change anything." },
];

export function roleLabel(role: CompanyMemberRole): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}
