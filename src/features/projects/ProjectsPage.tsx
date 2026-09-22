import { Link } from "@tanstack/react-router";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState } from "@/components/states/AsyncState";

export function ProjectsPage() {
  const { companyId, mode } = useSession();
  const live = mode === "live";
  return <AppShell title="Projects" subtitle={live ? "Projects, assigned vendors, and the requirements that apply." : "Demo mode — project changes are not saved."} actions={<Link to="/dashboard/requirement-profiles" className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium">Requirement profiles</Link>}>
    {!live ? <EmptyState title="No live workspace" description="Projects are available in an activated workspace." /> : !companyId ? <EmptyState title="No workspace yet" description="Activate a company workspace before managing projects." /> : <EmptyState title="No projects yet" description="Create a project to assign existing vendors and apply insurance requirements." />}
  </AppShell>;
}
