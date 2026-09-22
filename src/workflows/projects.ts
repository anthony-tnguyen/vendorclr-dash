import type { ProjectRow, ProjectStatus } from "@/data/dbTypeAliases";
import { getSupabaseClient } from "@/lib/supabase/client";

export interface ProjectInput {
  name: string;
  location?: string;
  status: ProjectStatus;
}

export interface ValidProjectInput {
  name: string;
  location: string;
  status: ProjectStatus;
}

export interface SaveProjectInput extends ProjectInput {
  companyId: string;
  projectId?: string;
  projectNumber?: string;
  certificateHolderName?: string;
  certificateHolderAddress?: string;
  requirementProfileId?: string | null;
}

export function validateProjectInput(input: ProjectInput): ValidProjectInput {
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required");

  return {
    name,
    location: input.location?.trim() ?? "",
    status: input.status,
  };
}

/**
 * Persists an existing project or creates one for the active company. RLS,
 * relationship triggers, and profile-archive triggers make the authorization
 * decision; this function deliberately does not recreate those checks.
 */
export async function saveProject(input: SaveProjectInput): Promise<ProjectRow> {
  const value = validateProjectInput(input);
  const supabase = getSupabaseClient();
  const payload = {
    company_id: input.companyId,
    name: value.name,
    location: value.location,
    status: value.status,
    project_number: input.projectNumber?.trim() || null,
    certificate_holder_name: input.certificateHolderName?.trim() || "",
    certificate_holder_address: input.certificateHolderAddress?.trim() || "",
    default_requirement_profile_id: input.requirementProfileId ?? null,
  };

  const query = input.projectId
    ? supabase.from("projects").update(payload).eq("id", input.projectId)
    : supabase.from("projects").insert(payload);
  const result = await query.select("*").single();
  if (result.error) throw new Error(result.error.message);
  return result.data as ProjectRow;
}
