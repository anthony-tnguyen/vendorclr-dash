import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getSupabaseClient } from "@/lib/supabase/client";
import { saveProject } from "@/workflows/projects";

export function ProjectsPage() {
  const { companyId, companyRole, mode } = useSession();
  const live = mode === "live";
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [requirementProfileId, setRequirementProfileId] = useState("");
  const projects = useQuery({
    queryKey: ["projects", companyId],
    enabled: live && Boolean(companyId),
    queryFn: async () => {
      const result = await getSupabaseClient()
        .from("projects")
        .select("*")
        .eq("company_id", companyId!)
        .order("created_at", { ascending: false });
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  const profiles = useQuery({
    queryKey: ["requirement-profiles", companyId],
    enabled: live && Boolean(companyId),
    queryFn: async () => {
      const result = await getSupabaseClient()
        .from("requirement_profiles")
        .select("id, name")
        .eq("company_id", companyId!)
        .is("archived_at", null)
        .order("name");
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  const create = useMutation({
    mutationFn: () =>
      saveProject({
        companyId: companyId!,
        name,
        location,
        status: "active",
        requirementProfileId: requirementProfileId || null,
      }),
    onSuccess: () => {
      setName("");
      setLocation("");
      setRequirementProfileId("");
      void queryClient.invalidateQueries({ queryKey: ["projects", companyId] });
    },
  });
  const canWrite =
    live &&
    Boolean(companyId) &&
    ["owner", "risk_manager", "project_engineer"].includes(companyRole ?? "");
  return (
    <AppShell
      title="Projects"
      subtitle={
        live
          ? "Projects, assigned vendors, and the requirements that apply."
          : "Demo mode — project changes are not saved."
      }
      actions={
        <Link
          to="/dashboard/requirement-profiles"
          className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
        >
          Requirement profiles
        </Link>
      }
    >
      {!live ? (
        <EmptyState
          title="No live workspace"
          description="Projects are available in an activated workspace."
        />
      ) : !companyId ? (
        <EmptyState
          title="No workspace yet"
          description="Activate a company workspace before managing projects."
        />
      ) : (
        <div className="space-y-4">
          {canWrite ? (
            <form
              className="flex flex-wrap gap-2 rounded-md border border-border bg-card p-3"
              onSubmit={(event) => {
                event.preventDefault();
                create.mutate();
              }}
            >
              <label className="sr-only" htmlFor="project-name">
                Project name
              </label>
              <input
                id="project-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
              />
              <label className="sr-only" htmlFor="project-location">
                Location
              </label>
              <input
                id="project-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Location"
                className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
              />
              <label className="sr-only" htmlFor="project-profile">
                Requirement profile
              </label>
              <select
                id="project-profile"
                value={requirementProfileId}
                onChange={(event) => setRequirementProfileId(event.target.value)}
                className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Company default</option>
                {(profiles.data ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={create.isPending}
                className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
              >
                {create.isPending ? "Saving…" : "Create project"}
              </button>
              {create.isError ? (
                <p role="alert" className="w-full text-xs text-destructive">
                  {create.error instanceof Error ? create.error.message : "Could not save project."}
                </p>
              ) : null}
            </form>
          ) : null}
          {projects.isLoading ? (
            <LoadingState label="Loading projects" rows={3} />
          ) : projects.isError ? (
            <ErrorState
              description="Could not load projects."
              onRetry={() => void projects.refetch()}
            />
          ) : (projects.data ?? []).length === 0 ? (
            <EmptyState
              title="No projects yet"
              description="Create a project to assign existing vendors and apply insurance requirements."
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Project</th>
                    <th className="px-3 py-2">Number</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.data!.map((project) => (
                    <tr key={project.id} className="border-b border-border last:border-0">
                      <th className="px-3 py-2 font-medium">
                        <Link
                          to="/dashboard/projects/$projectId"
                          params={{ projectId: project.id }}
                          className="focusable underline"
                        >
                          {project.name}
                        </Link>
                      </th>
                      <td className="px-3 py-2">{project.project_number ?? "—"}</td>
                      <td className="px-3 py-2">{project.location || "—"}</td>
                      <td className="px-3 py-2 capitalize">{project.status.replace("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
