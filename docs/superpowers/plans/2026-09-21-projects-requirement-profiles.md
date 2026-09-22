# Projects and Requirement Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Deliver tenant-safe customer Projects and Requirement Profiles workflows on the existing construction-core backend.

**Architecture:** Add typed RLS-scoped workflow modules, then compose Projects, Project Detail, and Requirement Profiles routes around them. Extend existing tables only for missing location/profile archival and database-enforced audit history; never introduce another project, assignment, rule, profile, or resolver model.

**Tech Stack:** React 19, TanStack Router/Query, TypeScript, Supabase/Postgres RLS, Vitest/PGlite, Playwright, Bun.

**Spec:** \`docs/superpowers/specs/2026-09-19-projects-requirement-profiles-design.md\`

## Global Constraints

- Preserve resolver precedence: assignment profile → project profile → company default → applicable overrides.
- \`resolve_assignment_requirements(assignment_id)\` is the only effective-requirement authority.
- Reuse \`REQUIREMENT_CATALOG\`, Settings validation, rule vocabulary, and request-scoped Supabase clients.
- RLS/database functions are the security boundary; client-side role checks are presentation only.
- Archive by status/state instead of deleting; one vendor may have many project assignments but only one per project.
- A configured workspace never executes demo-only writes.
- Every behavior starts with a failing focused test.

---

### Task 1: Extend existing schema, constraints, and audit history

**Files:**

- Create: generated \`supabase/migrations/<timestamp>_projects_requirement_profiles_customer_workflow.sql\`
- Modify: \`src/data/db-types.ts\`, \`src/data/dbTypeAliases.ts\`
- Test: \`supabase/tests/projects-requirement-profiles-workflow.test.ts\`, \`supabase/tests/rls.test.ts\`

**Interfaces:**

- Produces: \`projects.location\`, nullable \`requirement_profiles.archived_at\`, profile archival guards, and audited project/profile/assignment lifecycle events.

- [ ] **Step 1: Write failing database tests.**

\`\`\`ts
expect(project.location).toBe("100 Main St, Oakland, CA");
expect(archivedProfile.archived_at).not.toBeNull();
expect(await resolver(assignment.id)).toEqual(expect.arrayContaining([
expect.objectContaining({ key: "general_liability_each_occurrence_limit", amount: 5_000_000 }),
]));
expect(await activeAssignments(project.id)).not.toContainEqual(
expect.objectContaining({ id: terminatedAssignment.id }),
);
await expect(crossCompanyProjectUpdate()).rejects.toThrow();
\`\`\`

- [ ] **Step 2: Verify RED.**

Run: \`bun run db:verify -- projects-requirement-profiles-workflow.test.ts\`

Expected: FAIL because location/archive guards/audit events do not exist.

- [ ] **Step 3: Implement the additive migration.**

Add \`projects.location text not null default ''\` and \`requirement_profiles.archived_at timestamptz\`, with an active-profile index. Add server-enforced guards: archived profiles cannot be selected or made default; the last active default cannot be archived; all profile/project/assignment company references must match. Existing assignments pointing to a newly archived profile retain their resolver result; archive prevents new selection. Add auditable database triggers or guarded RPCs for project, assignment, and profile lifecycle events, widening \`audit_log\` constraints with exact event names. Do not change resolver precedence.

- [ ] **Step 4: Regenerate types and aliases.**

Keep project status \`active | on_hold | closed\` and assignment status \`active | completed | terminated\`; include new location/archive fields.

- [ ] **Step 5: Verify GREEN and commit.**

\`\`\`bash
bun run db:verify -- projects-requirement-profiles-workflow.test.ts
bun run db:verify -- rls.test.ts
git add supabase/migrations supabase/tests src/data/db-types.ts src/data/dbTypeAliases.ts
git commit -m "feat: audit project requirement workflow"
\`\`\`

### Task 2: Create typed workflow APIs

**Files:**

- Create: \`src/workflows/projects.ts\`, \`src/workflows/requirementProfiles.ts\`
- Modify: \`src/data/repositories/projectRepository.ts\`, \`src/data/repositories/requirementRepository.ts\`
- Test: \`src/tests/projects-workflow.test.ts\`, \`src/tests/requirement-profiles-workflow.test.ts\`

**Interfaces:**

- Produces: \`listProjectSummaries(companyId)\`, \`saveProject(input)\`, \`archiveProject(id)\`, \`saveAssignment(input)\`, \`deactivateAssignment(id)\`, \`listRequirementProfiles(companyId, includeArchived)\`, \`saveRequirementProfile(input)\`, \`archiveRequirementProfile(id)\`, \`setCompanyDefaultProfile(id)\`.

- [ ] **Step 1: Write failing API tests.**

\`\`\`ts
await expect(saveProject({ companyId, name: "", status: "active" })).rejects.toThrow("Project name is required");
await expect(saveAssignment({ companyId, projectId, vendorId })).rejects.toThrow(/already assigned/i);
await expect(saveRequirementProfile({ companyId, name: "" })).rejects.toThrow("Profile name is required");
expect((await listRequirementProfiles(companyId)).every((row) => !row.archived_at)).toBe(true);
\`\`\`

- [ ] **Step 2: Verify RED.**

Run: \`bun run test -- projects-workflow.test.ts requirement-profiles-workflow.test.ts\`

Expected: FAIL because the workflow exports do not exist.

- [ ] **Step 3: Implement narrow RLS-scoped modules.**

Validate trimmed names, non-negative integer contract values, allowed status/trade/risk vocabularies, and optional IDs. Select and return persistence results; preserve database errors for truthful UI display. Build summaries from active assignments and actual compliance/deficiency data only. Use the resolver per assignment and expose its source as a label; never reimplement precedence in TypeScript. Reuse Settings catalog behavior and preserve unknown rules.

- [ ] **Step 4: Verify GREEN and commit.**

\`\`\`bash
bun run test -- projects-workflow.test.ts requirement-profiles-workflow.test.ts
git add src/workflows src/data/repositories src/tests
git commit -m "feat: add project and profile workflows"
\`\`\`

### Task 3: Add navigation, routes, and live-state handling

**Files:**

- Modify: \`src/app/router.ts\`
- Create: \`src/routes/dashboard.projects.index.tsx\`, \`src/routes/dashboard.projects.$projectId.tsx\`, \`src/routes/dashboard.requirement-profiles.tsx\`
- Create: \`src/features/projects/ProjectsPage.tsx\`
- Test: \`src/tests/projects-routes.test.tsx\`

- [ ] **Step 1: Write failing nav/route tests.**

\`\`\`tsx
expect(customerNav).toContainEqual(expect.objectContaining({ label: "Projects", to: "/dashboard/projects" }));
renderRoute("/dashboard/projects");
expect(await screen.findByRole("heading", { name: "Projects" })).toBeVisible();
expect(screen.getByText("No projects yet")).toBeVisible();
\`\`\`

- [ ] **Step 2: Verify RED.**

Run: \`bun run test -- projects-routes.test.tsx\`

Expected: FAIL because the customer nav and routes are absent.

- [ ] **Step 3: Implement the file routes and states.**

Add the Projects navigation item and route metadata following Team/Vendors conventions. Every screen uses \`AppShell\`, query gating on live \`companyId\`, and LoadingState/ErrorState/EmptyState. Demo mode clearly says non-persistent and never claims a save; live mode without a company gives a no-workspace state. Create controls appear only for roles supported by RLS.

- [ ] **Step 4: Verify GREEN and commit.**

\`\`\`bash
bun run test -- projects-routes.test.tsx
git add src/app/router.ts src/routes src/features/projects src/tests/projects-routes.test.tsx
git commit -m "feat: add projects dashboard routes"
\`\`\`

### Task 4: Build Projects list and validated project form

**Files:**

- Create: \`src/features/projects/ProjectForm.tsx\`, \`src/features/projects/projectFormat.ts\`
- Modify: \`src/features/projects/ProjectsPage.tsx\`
- Test: \`src/tests/projects-page.test.tsx\`

- [ ] **Step 1: Write failing user interaction tests.**

\`\`\`tsx
await user.click(screen.getByRole("button", { name: "Create project" }));
await user.click(screen.getByRole("button", { name: "Save project" }));
expect(await screen.findByText("Project name is required")).toBeVisible();
await user.type(screen.getByLabelText("Project name"), "Harbor Tower");
await user.selectOptions(screen.getByLabelText("Requirement profile"), "profile-high-risk");
await user.click(screen.getByRole("button", { name: "Save project" }));
expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Harbor Tower" }));
\`\`\`

- [ ] **Step 2: Verify RED.**

Run: \`bun run test -- projects-page.test.tsx\`

Expected: FAIL because the form/list actions are absent.

- [ ] **Step 3: Implement list, form, and archive.**

List name, number, status, location, selected/inherited profile, active vendor count, and actual compliance summary. Form fields are name, number, location, status, certificate holder name/address, and optional profile. Archive confirms then changes only project status to \`closed\`; it never deletes. Preserve values on error and invalidate only related query keys. Test read-only control absence and query/mutation failure alerts.

- [ ] **Step 4: Verify GREEN and commit.**

\`\`\`bash
bun run test -- projects-page.test.tsx
git add src/features/projects src/tests/projects-page.test.tsx
git commit -m "feat: manage customer projects"
\`\`\`

### Task 5: Build project detail, assignments, and effective requirements

**Files:**

- Create: \`src/features/projects/ProjectDetailPage.tsx\`, \`src/features/projects/AssignmentForm.tsx\`, \`src/features/projects/EffectiveRequirementsPanel.tsx\`
- Test: \`src/tests/project-detail-page.test.tsx\`

- [ ] **Step 1: Write failing detail/assignment tests.**

\`\`\`tsx
render(<ProjectDetailPage projectId="project-1" />);
expect(await screen.findByText("Inherited from company default")).toBeVisible();
expect(screen.getByText("General liability — each occurrence")).toBeVisible();
await user.selectOptions(screen.getByLabelText("Vendor"), "vendor-1");
await user.selectOptions(screen.getByLabelText("Trade"), "Electrical");
await user.click(screen.getByRole("button", { name: "Assign vendor" }));
expect(saveAssignment).toHaveBeenCalledWith(expect.objectContaining({ vendorId: "vendor-1" }));
\`\`\`

- [ ] **Step 2: Verify RED.**

Run: \`bun run test -- project-detail-page.test.tsx\`

Expected: FAIL because project detail and assignment management are absent.

- [ ] **Step 3: Implement detail panels and assignments.**

Show project information, certificate holder, selected/inherited profile, overrides, and each active assignment’s real resolver output. Clearly distinguish no project profile from company-default inheritance; a project with no assignments gets no fabricated effective result. The assignment table shows vendor, trade, contract value, risk tier, profile, compliance/deficiencies, and expiration warning only when supported by live data. Select company-scoped existing vendors; edit in place; terminate rather than delete. Cover duplicate, denied, inactive, and mutation-error cases.

- [ ] **Step 4: Verify GREEN and commit.**

\`\`\`bash
bun run test -- project-detail-page.test.tsx
git add src/features/projects src/tests/project-detail-page.test.tsx
git commit -m "feat: add assignments and effective requirements"
\`\`\`

### Task 6: Build Requirement Profiles and shared rule editor

**Files:**

- Create: \`src/features/requirement-profiles/RequirementProfilesPage.tsx\`, \`src/features/requirement-profiles/RequirementProfileEditor.tsx\`, \`src/features/requirement-profiles/ProfileRulesEditor.tsx\`
- Modify: \`src/data/repositories/requirementSettings.ts\`
- Test: \`src/tests/requirement-profiles-page.test.tsx\`

- [ ] **Step 1: Write failing editor tests.**

\`\`\`tsx
await user.click(screen.getByRole("button", { name: "New profile" }));
await user.type(screen.getByLabelText("Profile name"), "High-Risk Subcontractor");
await user.click(screen.getByRole("button", { name: "Create profile" }));
expect(saveRequirementProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "High-Risk Subcontractor" }));
await user.click(screen.getByLabelText("Additional insured"));
await user.click(screen.getByRole("button", { name: "Save rules" }));
expect(saveProfileRules).toHaveBeenCalled();
\`\`\`

- [ ] **Step 2: Verify RED.**

Run: \`bun run test -- requirement-profiles-page.test.tsx\`

Expected: FAIL because profile management is absent.

- [ ] **Step 3: Implement lifecycle controls and reuse Settings semantics.**

List profiles, default indicator, rule count, and archive/default actions. Read-only users inspect but cannot mutate. Default profiles cannot be archived. Extract only shared pure catalog/value mapping necessary for Settings and this editor to use identical labels, configuration, validation, and persistence semantics. Render coverage, endorsement, certificate-holder, and document requirements; show unknown stored rules without overwriting them. Test permission gates, safe default swap, validation, and failed API state.

- [ ] **Step 4: Verify GREEN and commit.**

\`\`\`bash
bun run test -- requirement-profiles-page.test.tsx
git add src/features/requirement-profiles src/data/repositories/requirementSettings.ts src/tests/requirement-profiles-page.test.tsx
git commit -m "feat: manage requirement profiles"
\`\`\`

### Task 7: E2E, documentation, and full verification

**Files:**

- Create: \`e2e/projects-requirement-profiles.spec.ts\`
- Modify: \`roadmap.md\`, \`docs/product/action-truth-inventory.md\`, current blocker/status Markdown under \`.lovable/plan/\`
- Modify: \`README.md\` only if it indexes dashboard routes

- [ ] **Step 1: Write failing E2E journey.**

\`\`\`ts
test("owner creates a project, assigns a vendor, and inspects effective requirements", async ({ page }) => {
await signInAsOwner(page);
await page.getByRole("link", { name: "Projects" }).click();
await page.getByRole("button", { name: "Create project" }).click();
await page.getByLabel("Project name").fill("Harbor Tower");
await page.getByLabel("Requirement profile").selectOption({ label: "High-Risk Subcontractor" });
await page.getByRole("button", { name: "Save project" }).click();
await page.getByRole("button", { name: "Assign vendor" }).click();
await page.getByLabel("Trade").selectOption("Electrical");
await page.getByLabel("Contract value").fill("250000");
await page.getByRole("button", { name: "Save assignment" }).click();
await expect(page.getByText("Effective insurance requirements")).toBeVisible();
});
\`\`\`

- [ ] **Step 2: Verify RED, complete using existing auth fixtures, then verify GREEN.**

Run: \`bun run e2e -- projects-requirement-profiles.spec.ts\`

Expected initially: FAIL because Projects does not exist. The final test uses existing authenticated fixtures, never a browser service credential, and includes read-only and archived-assignment assertions.

- [ ] **Step 3: Update product truth.**

Mark the workflow complete only after all automated paths pass. Identify the migration application/hosted verification separately from code completion, and keep Contacts/Requests, Packages, and Deficiencies/Exceptions accurately partial/open.

- [ ] **Step 4: Run the full gate and commit.**

\`\`\`bash
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run db:verify
bun run build
bun run e2e
git add roadmap.md docs/product .lovable/plan e2e README.md
git commit -m "docs: record projects workflow status"
\`\`\`

## Plan Self-Review

- Spec coverage: Tasks 1–7 cover navigation, project list/form/detail, assignment lifecycle, profile/rule lifecycle, permissions, states, audit/RLS, E2E, documentation, and every requested verification command.
- Placeholder scan: all tasks identify exact files, named interfaces, failing test behaviors, commands, and completion commits.
- Type consistency: project status is \`active | on_hold | closed\`; assignment status is \`active | completed | terminated\`; profile archive uses \`archived_at\`; all effective requirements come from the resolver.
