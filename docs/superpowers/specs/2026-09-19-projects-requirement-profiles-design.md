# Projects and Requirement Profiles Design

## Goal

Make VendorClr's existing construction project, assignment, requirement-profile, override, and effective-resolution backend usable by an authenticated customer without creating parallel data models or weakening database authorization.

## Existing-system constraints

- `projects`, `project_vendor_assignments`, `requirement_profiles`, `requirement_profile_rules`, and `project_requirement_overrides` remain the only persistence model.
- `resolve_assignment_requirements(assignment_id)` remains the source of truth for assignment-effective requirements and precedence: assignment profile, project profile, company default, then applicable project overrides.
- Reads and mutations use the request-scoped Supabase client. Existing RLS policies remain the security boundary; UI role gates are presentation only.
- A vendor can have many active project assignments. The UI must create and edit assignment records; it must never clone vendor records.
- Reuse `REQUIREMENT_CATALOG` and Settings validation/mapping so edited rules retain the exact vocabulary consumed by the compliance evaluator.
- No configured live workspace may silently fall back to demo-only mutations. Demo mode remains explicitly non-persistent.

## Routes and navigation

Add `Projects` to the customer navigation and create:

- `/dashboard/projects` for the company-scoped project list, create/edit/archive actions, and empty/error states.
- `/dashboard/projects/$projectId` for a project record, project profile and override context, and its vendor assignments.
- `/dashboard/requirement-profiles` for profile management and the shared rule editor.

All pages render inside `AppShell`, use the current TanStack file-route convention, and use the existing async state components.

## Data flow

Client-facing workflow modules encapsulate the existing request-scoped Supabase calls. Query hooks call those modules only when a live authenticated workspace has a `companyId`; mutations invalidate the smallest relevant query keys.

The project list reads projects, profiles, assignments, and compliance-case/deficiency summaries scoped by RLS. It presents profile selection as explicit, inherited company default, or none. The detail page reads the selected project, all assignments, linked vendors and profiles, overrides, and each assignment's resolver result. It labels the winning source in plain language rather than exposing the raw precedence algorithm.

Project and assignment forms validate required name and valid numeric contract values before a write. Archive/deactivate is a status update, not a destructive delete. Assignment removal is an `active` state update rather than deleting historical assignment/compliance evidence. The implementation must map the existing schema's actual status values before adding any mutation.

## Project experience

The list shows name, number, status, location, selected/inherited requirement profile, active vendor count, and an assignment-based compliance signal. It supports opening detail, creating, editing, and archiving a project. A no-project state contains the create action only for write-capable roles.

The detail page shows project information and certificate-holder details; it distinguishes a project-selected profile from company-default inheritance and enumerates project overrides. The vendor-assignment table shows vendor, trade, contract value, risk classification, optional assignment profile, effective compliance, open deficiencies, and an expiry signal where the existing data supports it.

## Assignment experience

Authorized users can select an existing vendor, create one assignment to the current project, and update trade, contract value, risk classification, and assignment-specific profile. The interface blocks duplicate active assignment creation in the form and surfaces a server/RLS/unique-constraint failure instead of claiming success. Deactivation removes the row from the active table while preserving the record for history.

## Requirement profile experience

The profile page lists all company profiles and identifies the company default. Authorized users can create, rename, archive, select a default, and edit rules. It uses the existing Settings catalog and validation for coverage, endorsement, certificate-holder, and document requirements; unrecognized stored rules remain visible and are not overwritten. Profile selection happens from project and assignment forms, not through copied profile data.

Changing a default must preserve the existing last-default database invariant. Profile and rule changes use existing audit mechanisms; the implementation will add a narrowly scoped, audited database path only if inspection proves profile/project/assignment mutations lack the current architecture's business audit coverage.

## Authorization and failure behavior

- Owners and risk managers receive the controls RLS already permits for requirements and projects.
- Project engineers receive only controls supported by current assignment/project RLS; read-only users receive views only.
- Database errors, permission denials, unavailable APIs, empty profiles, project-without-profile, archived projects, and no assignments have distinct truthful states.
- No client-supplied company ID, vendor ID, profile ID, or assignment ID is trusted beyond database/RLS validation.

## Tests and verification

Tests cover project listing, validation and edit/archive state, profile editing/default handling, assignment creation/update/deactivation, role presentation gates, duplicate assignment feedback, and resolver-sourced effective requirements. Database tests prove cross-company denial, independent assignments for one vendor, precedence, immutable base profiles when overrides change, inactive assignments excluded from active lists, and default-profile integrity. The browser E2E journey creates a project, selects a profile, assigns an existing vendor, updates assignment fields, and verifies the effective-requirements view.

Documentation updates accurately state what is customer-operable, what still depends on unimplemented neighboring prompts, and any external or migration deployment requirement.
