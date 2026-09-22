import { AppShell } from "@/components/shell/AppShell";
import { EmptyState } from "@/components/states/AsyncState";

export function RequirementProfilesPage() {
  return <AppShell title="Requirement profiles" subtitle="Reusable insurance requirements for projects and assignments.">
    <EmptyState title="No requirement profiles yet" description="Create a profile to apply its rules to projects and vendor assignments." />
  </AppShell>;
}
