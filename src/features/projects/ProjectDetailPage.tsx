import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getSupabaseClient } from "@/lib/supabase/client";
import { requirementSourceLabel, saveProject } from "@/workflows/projects";
import { ComplianceCasesSection } from "@/features/compliance/ComplianceCasesSection";

type ResolvedRequirement = {
  key: string;
  policy_type: string;
  kind: string;
  required: boolean;
  amount: number;
  source: string;
};
type ProjectStatus = "active" | "on_hold" | "closed";

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const { companyId, companyRole, mode } = useSession();
  const queryClient = useQueryClient();
  const canWrite =
    mode === "live" &&
    Boolean(companyId) &&
    ["owner", "risk_manager", "project_engineer"].includes(companyRole ?? "");
  // Exception approval is owner/risk_manager only - mirrors approve_compliance_exception().
  const canApprove = mode === "live" && ["owner", "risk_manager"].includes(companyRole ?? "");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [vendorId, setVendorId] = useState("");
  const [tradeCode, setTradeCode] = useState("");
  const [contractValue, setContractValue] = useState("");
  const [riskClassification, setRiskClassification] = useState("");
  const [projectProfileId, setProjectProfileId] = useState("");
  const [assignmentProfileId, setAssignmentProfileId] = useState("");
  const [projectNumber, setProjectNumber] = useState("");
  const [certificateHolderName, setCertificateHolderName] = useState("");
  const [certificateHolderAddress, setCertificateHolderAddress] = useState("");

  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => {
      const result = await getSupabaseClient()
        .from("projects")
        .select("*")
        .eq("id", projectId)
        .maybeSingle();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  useEffect(() => {
    if (project.data) {
      setName(project.data.name);
      setLocation(project.data.location ?? "");
      setStatus(project.data.status as ProjectStatus);
      setProjectProfileId(project.data.default_requirement_profile_id ?? "");
      setProjectNumber(project.data.project_number ?? "");
      setCertificateHolderName(project.data.certificate_holder_name ?? "");
      setCertificateHolderAddress(project.data.certificate_holder_address ?? "");
    }
  }, [project.data]);

  const assignments = useQuery({
    queryKey: ["project-assignments", projectId],
    enabled: Boolean(project.data),
    queryFn: async () => {
      const result = await getSupabaseClient()
        .from("project_vendor_assignments")
        .select(
          "id, vendor_id, trade_code, contract_value, risk_classification, status, vendor:vendors(name)",
        )
        .eq("project_id", projectId)
        .eq("status", "active");
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  const vendors = useQuery({
    queryKey: ["assignable-vendors", companyId],
    enabled: canWrite,
    queryFn: async () => {
      const result = await getSupabaseClient()
        .from("vendors")
        .select("id, name")
        .eq("company_id", companyId!)
        .is("archived_at", null)
        .order("name");
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  const profiles = useQuery({
    queryKey: ["requirement-profiles", companyId],
    enabled: canWrite,
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
  const resolvedRequirements = useQuery({
    queryKey: [
      "effective-assignment-requirements",
      projectId,
      assignments.data?.map((assignment) => assignment.id).join(","),
    ],
    enabled: Boolean(assignments.data?.length),
    queryFn: async () => {
      const results = await Promise.all(
        (assignments.data ?? []).map(async (assignment) => {
          const result = await getSupabaseClient().rpc("resolve_assignment_requirements", {
            assignment_id: assignment.id,
          });
          if (result.error) throw new Error(result.error.message);
          return [assignment.id, result.data as ResolvedRequirement[]] as const;
        }),
      );
      return Object.fromEntries(results) as Record<string, ResolvedRequirement[]>;
    },
  });
  const updateProject = useMutation({
    mutationFn: () =>
      saveProject({
        companyId: companyId!,
        projectId,
        name,
        location,
        status,
        projectNumber,
        certificateHolderName,
        certificateHolderAddress,
        requirementProfileId: projectProfileId || null,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });
  const addAssignment = useMutation({
    mutationFn: async () => {
      const parsedContractValue = contractValue.trim() === "" ? null : Number(contractValue);
      if (
        parsedContractValue !== null &&
        (!Number.isFinite(parsedContractValue) || parsedContractValue < 0)
      )
        throw new Error("Contract value must be a non-negative number.");
      const result = await getSupabaseClient()
        .from("project_vendor_assignments")
        .insert({
          company_id: companyId!,
          project_id: projectId,
          vendor_id: vendorId,
          trade_code: tradeCode.trim() || null,
          contract_value: parsedContractValue,
          risk_classification: riskClassification.trim() || null,
          requirement_profile_id: assignmentProfileId || null,
          status: "active",
        });
      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: () => {
      setVendorId("");
      setTradeCode("");
      setContractValue("");
      setRiskClassification("");
      setAssignmentProfileId("");
      void queryClient.invalidateQueries({ queryKey: ["project-assignments", projectId] });
    },
  });
  const deactivateAssignment = useMutation({
    mutationFn: async (assignmentId: string) => {
      const result = await getSupabaseClient()
        .from("project_vendor_assignments")
        .update({ status: "terminated" })
        .eq("id", assignmentId);
      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["project-assignments", projectId] }),
  });

  return (
    <AppShell
      title={project.data?.name ?? "Project detail"}
      subtitle="Project information, vendor assignments, and resolver-backed insurance requirements."
      actions={
        <Link
          to="/dashboard/projects"
          className="focusable rounded-sm border border-border px-3 py-2 text-sm font-medium"
        >
          Back to projects
        </Link>
      }
    >
      {project.isLoading ? (
        <LoadingState label="Loading project" rows={3} />
      ) : project.isError ? (
        <ErrorState
          description="Could not load this project."
          onRetry={() => void project.refetch()}
        />
      ) : !project.data ? (
        <EmptyState
          title="Project not found"
          description="This project is unavailable or outside your workspace."
        />
      ) : (
        <div className="space-y-4">
          {canWrite ? (
            <form
              className="grid gap-2 rounded-md border border-border bg-card p-4 sm:grid-cols-5"
              onSubmit={(event) => {
                event.preventDefault();
                updateProject.mutate();
              }}
            >
              <label className="grid gap-1 text-sm font-medium">
                Project name
                <input
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Location
                <input
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Project number
                <input
                  value={projectNumber}
                  onChange={(event) => setProjectNumber(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Certificate holder
                <input
                  value={certificateHolderName}
                  onChange={(event) => setCertificateHolderName(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Certificate holder address
                <input
                  value={certificateHolderAddress}
                  onChange={(event) => setCertificateHolderAddress(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Status
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value as ProjectStatus)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="active">Active</option>
                  <option value="on_hold">On hold</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Requirement profile
                <select
                  value={projectProfileId}
                  onChange={(event) => setProjectProfileId(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Company default</option>
                  {(profiles.data ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={updateProject.isPending}
                  className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                >
                  {updateProject.isPending ? "Saving…" : "Save project"}
                </button>
              </div>
              {updateProject.isError ? (
                <p role="alert" className="sm:col-span-5 text-xs text-destructive">
                  {updateProject.error instanceof Error
                    ? updateProject.error.message
                    : "Could not update project."}
                </p>
              ) : null}
            </form>
          ) : null}
          <dl className="grid gap-3 rounded-md border border-border bg-card p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Project number</dt>
              <dd>{project.data.project_number ?? "Not set"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="capitalize">{project.data.status.replace("_", " ")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Location</dt>
              <dd>{project.data.location || "Not set"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Certificate holder</dt>
              <dd>{project.data.certificate_holder_name || "Not set"}</dd>
            </div>
          </dl>
          {canWrite ? (
            <form
              className="grid gap-2 rounded-md border border-border bg-card p-4 sm:grid-cols-6"
              onSubmit={(event) => {
                event.preventDefault();
                addAssignment.mutate();
              }}
            >
              <label className="grid gap-1 text-sm font-medium">
                Vendor
                <select
                  required
                  value={vendorId}
                  onChange={(event) => setVendorId(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select vendor</option>
                  {(vendors.data ?? []).map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Trade
                <input
                  value={tradeCode}
                  onChange={(event) => setTradeCode(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Contract value
                <input
                  inputMode="decimal"
                  value={contractValue}
                  onChange={(event) => setContractValue(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Risk classification
                <input
                  value={riskClassification}
                  onChange={(event) => setRiskClassification(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium">
                Requirement profile
                <select
                  value={assignmentProfileId}
                  onChange={(event) => setAssignmentProfileId(event.target.value)}
                  className="focusable rounded-sm border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Project/default</option>
                  {(profiles.data ?? []).map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={addAssignment.isPending || vendors.isLoading}
                  className="focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                >
                  {addAssignment.isPending ? "Assigning…" : "Assign vendor"}
                </button>
              </div>
              {addAssignment.isError ? (
                <p role="alert" className="sm:col-span-6 text-xs text-destructive">
                  {addAssignment.error instanceof Error
                    ? addAssignment.error.message
                    : "Could not assign vendor."}
                </p>
              ) : null}
            </form>
          ) : null}
          <section className="rounded-md border border-border bg-card">
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
              Assigned vendors
            </h2>
            {assignments.isLoading ? (
              <LoadingState label="Loading assignments" rows={2} />
            ) : assignments.isError ? (
              <ErrorState
                description="Could not load project assignments."
                onRetry={() => void assignments.refetch()}
              />
            ) : (assignments.data ?? []).length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No vendors are assigned to this project.
              </p>
            ) : (
              <ul>
                {assignments.data!.map((assignment) => (
                  <li
                    key={assignment.id}
                    className="border-b border-border px-4 py-3 text-sm last:border-0"
                  >
                    <div className="grid gap-1 sm:grid-cols-5">
                      <span className="font-medium">
                        {/* vendor:vendors(name) is a to-one embed (vendor_id is a single FK
                            column on this table), so PostgREST returns it as an object -
                            confirmed live. postgrest-js infers a result type purely from the
                            select string, with no way to know the real FK cardinality, and
                            always defaults an embed to an array - the cast corrects that;
                            without it this silently rendered "Unknown vendor" on every row. */}
                        {(assignment.vendor as unknown as { name: string } | null)?.name ??
                          "Unknown vendor"}
                      </span>
                      <span>{assignment.trade_code ?? "Trade not set"}</span>
                      <span>
                        {assignment.contract_value === null
                          ? "Contract value not set"
                          : `$${assignment.contract_value.toLocaleString()}`}
                      </span>
                      <span className="capitalize">
                        {assignment.risk_classification ?? "Risk not set"}
                      </span>
                      {canWrite ? (
                        <button
                          type="button"
                          disabled={deactivateAssignment.isPending}
                          onClick={() => deactivateAssignment.mutate(assignment.id)}
                          className="focusable justify-self-start rounded-sm border border-border px-2 py-1 text-xs"
                        >
                          End assignment
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-3 rounded-sm bg-muted/40 p-3">
                      <p className="text-xs font-semibold text-muted-foreground">
                        Effective requirements
                      </p>
                      {resolvedRequirements.isLoading ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Resolving requirements…
                        </p>
                      ) : resolvedRequirements.isError ? (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          Could not resolve requirements.
                        </p>
                      ) : (resolvedRequirements.data?.[assignment.id] ?? []).length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          No requirements were returned by the resolver.
                        </p>
                      ) : (
                        <ul className="mt-2 grid gap-1 text-xs">
                          {(resolvedRequirements.data?.[assignment.id] ?? []).map((requirement) => (
                            <li key={requirement.key} className="grid gap-1 sm:grid-cols-4">
                              <span className="font-medium">
                                {requirement.key.replaceAll("_", " ")}
                              </span>
                              <span>{requirement.required ? "Required" : "Optional"}</span>
                              <span>
                                {requirement.amount
                                  ? `$${requirement.amount.toLocaleString()}`
                                  : requirement.policy_type}
                              </span>
                              <span className="text-muted-foreground">
                                {requirementSourceLabel(requirement.source)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="mt-3 border-t border-border pt-3">
                      <p className="text-xs font-semibold text-muted-foreground">
                        Compliance cases
                      </p>
                      <div className="mt-2">
                        <ComplianceCasesSection
                          vendorId={assignment.vendor_id}
                          assignmentId={assignment.id}
                          canWrite={canWrite}
                          canApprove={canApprove}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
