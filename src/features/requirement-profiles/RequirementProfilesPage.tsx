import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getSupabaseClient } from "@/lib/supabase/client";

export function RequirementProfilesPage() {
  const { companyId, companyRole, mode } = useSession();
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const live = mode === "live";
  const canEdit = companyRole === "owner" || companyRole === "risk_manager";
  const profiles = useQuery({
    queryKey: ["requirement-profiles", companyId],
    enabled: live && Boolean(companyId),
    queryFn: async () => {
      const result = await getSupabaseClient()
        .from("requirement_profiles")
        .select("*")
        .eq("company_id", companyId!)
        .is("archived_at", null)
        .order("name");
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Profile name is required");
      const result = await getSupabaseClient()
        .from("requirement_profiles")
        .insert({ company_id: companyId!, name: trimmed })
        .select("*")
        .single();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["requirement-profiles", companyId] });
    },
  });
  return (
    <AppShell
      title="Requirement profiles"
      subtitle="Reusable insurance requirements for projects and assignments."
    >
      {!live ? (
        <EmptyState
          title="No live workspace"
          description="Profiles are managed in an activated workspace."
        />
      ) : !companyId ? (
        <EmptyState
          title="No workspace yet"
          description="Activate a workspace before managing requirements."
        />
      ) : (
        <div className="space-y-4">
          {canEdit ? (
            <form
              className="flex flex-wrap gap-2 rounded-md border border-border bg-card p-3"
              onSubmit={(event) => {
                event.preventDefault();
                create.mutate();
              }}
            >
              <label className="sr-only" htmlFor="profile-name">
                Profile name
              </label>
              <input
                id="profile-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Profile name"
                className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={create.isPending}
                className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
              >
                {create.isPending ? "Saving…" : "Create profile"}
              </button>
              {create.isError ? (
                <p role="alert" className="w-full text-xs text-destructive">
                  {create.error instanceof Error
                    ? create.error.message
                    : "Could not create profile."}
                </p>
              ) : null}
            </form>
          ) : null}
          {profiles.isLoading ? (
            <LoadingState label="Loading requirement profiles" rows={3} />
          ) : profiles.isError ? (
            <ErrorState
              description="Could not load requirement profiles."
              onRetry={() => void profiles.refetch()}
            />
          ) : (profiles.data ?? []).length === 0 ? (
            <EmptyState
              title="No requirement profiles yet"
              description="Create a profile to apply its rules to projects and vendor assignments."
            />
          ) : (
            <ul className="rounded-md border border-border bg-card">
              {profiles.data!.map((profile) => (
                <li
                  key={profile.id}
                  className="flex items-center justify-between border-b border-border px-3 py-3 last:border-0"
                >
                  <span className="font-medium">{profile.name}</span>
                  {profile.is_company_default ? (
                    <span className="rounded-sm bg-muted px-2 py-1 text-xs">Company default</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </AppShell>
  );
}
