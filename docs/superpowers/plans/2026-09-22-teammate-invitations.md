# Teammate Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the customer-facing UI for teammate invitations — invite, pending list, resend/revoke, and the `/accept-invite/$token` acceptance route — entirely on top of the already-built `company_invitations` backend and `src/workflows/companyInvitations.ts` workflow layer.

**Architecture:** Two new components (`InviteMemberForm`, `PendingInvitationsTable`) extend the existing `TeamPage.tsx`, sharing a new `roleOptions.ts` module with the vocabulary `TeamPage.tsx` already defines. A new public route `/accept-invite/$token` renders a new `AcceptInvitePage.tsx` that drives every required state off `previewCompanyInvitation` (a new thin `createServerFn` wrapper around the already-built `previewCompanyInvitationByToken`) and `acceptCompanyInvitation`. `Session` gains an `email` field so the accept page can compare the signed-in user's email to the invitation's locked email. The legacy disabled invite control on `/dashboard/admin/access` is removed.

**Tech Stack:** React, TanStack Router (file-based routes), TanStack Query, TanStack Start `createServerFn`, Vitest + Testing Library, Playwright.

**Reference spec:** `docs/superpowers/specs/2026-09-22-teammate-invitations-design.md`

---

## Before you start

Run these once to confirm the baseline is green:

```bash
bun run typecheck
bun run test
```

Both should pass with no changes yet. If either fails on a clean checkout, stop and investigate before starting this plan — do not build on a broken baseline.

---

### Task 1: Session exposes the signed-in user's email

**Files:**
- Modify: `src/app/App.tsx`

The accept-invite route needs to compare the signed-in user's email to the invitation's locked email. `Session` currently has no `email` field (only `personName`, which can be a display name).

- [ ] **Step 1: Add `email` to the `Session` interface**

In `src/app/App.tsx`, find:

```tsx
  refresh: () => void;
  userId: string | null;
  signOut: () => Promise<void>;
}
```

Replace with:

```tsx
  refresh: () => void;
  userId: string | null;
  /** The signed-in user's own email, or null in demo mode / before load. Used to match an invited address — the real check is still server-side inside accept_company_invitation(). */
  email: string | null;
  signOut: () => Promise<void>;
}
```

- [ ] **Step 2: Add `email: null` to `DEMO_FALLBACK` and `useDemoSessionValue()`**

Find:

```tsx
const DEMO_FALLBACK: Session = {
  mode: "demo",
  status: "authenticated",
  role: "customer",
  setRole: () => {},
  canSwitchRole: true,
  personName: "Rosa Sandoval",
  companyName: "Halstead Builders",
  companyId: null,
  companyRole: "owner",
  activation: "demo",
  isStaff: false,
  refresh: () => {},
  userId: null,
  signOut: async () => {},
};
```

Replace with:

```tsx
const DEMO_FALLBACK: Session = {
  mode: "demo",
  status: "authenticated",
  role: "customer",
  setRole: () => {},
  canSwitchRole: true,
  personName: "Rosa Sandoval",
  companyName: "Halstead Builders",
  companyId: null,
  companyRole: "owner",
  activation: "demo",
  isStaff: false,
  refresh: () => {},
  userId: null,
  email: null,
  signOut: async () => {},
};
```

Find (inside `useDemoSessionValue`):

```tsx
      activation: "demo" as CompanyActivationStatus,
      isStaff: false,
      refresh: () => {},
      userId: null,
      signOut: async () => {},
    }),
    [role],
  );
}
```

Replace with:

```tsx
      activation: "demo" as CompanyActivationStatus,
      isStaff: false,
      refresh: () => {},
      userId: null,
      email: null,
      signOut: async () => {},
    }),
    [role],
  );
}
```

- [ ] **Step 3: Add `email` to `LiveIdentity` and populate it**

Find:

```tsx
interface LiveIdentity {
  userId: string;
  personName: string;
  companyName: string;
  companyId: string | null;
  companyRole: CompanyRole | null;
  activation: CompanyActivationStatus | "none";
  isPlatformAdmin: boolean;
}
```

Replace with:

```tsx
interface LiveIdentity {
  userId: string;
  email: string;
  personName: string;
  companyName: string;
  companyId: string | null;
  companyRole: CompanyRole | null;
  activation: CompanyActivationStatus | "none";
  isPlatformAdmin: boolean;
}
```

Find (inside `loadIdentity`):

```tsx
      setIdentity({
        userId,
        personName: profileResult.data?.full_name ?? profileResult.data?.email ?? email,
```

Replace with:

```tsx
      setIdentity({
        userId,
        email,
        personName: profileResult.data?.full_name ?? profileResult.data?.email ?? email,
```

- [ ] **Step 4: Return `email` from `useLiveSessionValue()`**

Find:

```tsx
      activation: identity?.activation ?? "none",
      isStaff: identity?.isPlatformAdmin === true,
      refresh,
      userId: identity?.userId ?? null,
      signOut,
    }),
    [status, role, canSwitchRole, identity, setRole, signOut, refresh],
  );
}
```

Replace with:

```tsx
      activation: identity?.activation ?? "none",
      isStaff: identity?.isPlatformAdmin === true,
      refresh,
      userId: identity?.userId ?? null,
      email: identity?.email ?? null,
      signOut,
    }),
    [status, role, canSwitchRole, identity, setRole, signOut, refresh],
  );
}
```

- [ ] **Step 5: Typecheck and run the existing suite**

```bash
bun run typecheck
bun run test -- src/tests/team-page.test.tsx
```

Expected: both pass. (`team-page.test.tsx` exercises `useLiveSessionValue()` through a mocked Supabase client, so this proves `email` flows through without breaking existing behavior.)

- [ ] **Step 6: Commit**

```bash
git add src/app/App.tsx
git commit -m "$(cat <<'EOF'
feat: expose the signed-in user's email on Session

The accept-invite route needs to compare the caller's own email to an
invitation's locked email for its wrong-account UX. Real enforcement
stays server-side in accept_company_invitation(); this is presentation
only, consistent with every other Session field.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract shared role vocabulary

**Files:**
- Create: `src/features/team/roleOptions.ts`
- Modify: `src/features/team/TeamPage.tsx`

`TeamPage.tsx` currently defines `ROLE_OPTIONS` and `roleLabel()` locally. The new invite form, pending-invitations table, and accept-invite page all need the same vocabulary — extracting it now avoids three copies drifting apart.

- [ ] **Step 1: Create `src/features/team/roleOptions.ts`**

```ts
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
```

- [ ] **Step 2: Update `TeamPage.tsx` to import from it instead of defining locally**

Find (near the top of `src/features/team/TeamPage.tsx`):

```tsx
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { isBackendConfigured } from "@/data/repository";
import {
  changeCompanyMemberRole,
  listCompanyMembers,
  removeCompanyMember,
  transferCompanyOwnership,
  type CompanyMemberRole,
  type CompanyMemberSummary,
} from "@/workflows/companyInvitations";

/**
 * Who is on this company's workspace, and what each person may do.
 *
 * Every mutation goes through a SECURITY DEFINER function that re-checks the
 * caller is an owner of the member's company, and the database refuses to leave
 * a company with no active owner - so hiding the controls from non-owners below
 * is presentation, not the security boundary.
 */

const ROLE_OPTIONS: Array<{ value: CompanyMemberRole; label: string; blurb: string }> = [
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

function roleLabel(role: CompanyMemberRole): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

function errorMessage(error: unknown): string {
```

Replace with:

```tsx
import { useSession } from "@/app/App";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { isBackendConfigured } from "@/data/repository";
import {
  changeCompanyMemberRole,
  listCompanyMembers,
  removeCompanyMember,
  transferCompanyOwnership,
  type CompanyMemberRole,
  type CompanyMemberSummary,
} from "@/workflows/companyInvitations";
import { InviteMemberForm } from "./InviteMemberForm";
import { PendingInvitationsTable } from "./PendingInvitationsTable";
import { ROLE_OPTIONS, roleLabel } from "./roleOptions";

/**
 * Who is on this company's workspace, and what each person may do.
 *
 * Every mutation goes through a SECURITY DEFINER function that re-checks the
 * caller is an owner of the member's company, and the database refuses to leave
 * a company with no active owner - so hiding the controls from non-owners below
 * is presentation, not the security boundary.
 */

function errorMessage(error: unknown): string {
```

This step also adds the imports Task 4/5 will need (`InviteMemberForm`, `PendingInvitationsTable`) — those files don't exist yet, so typecheck will fail until Task 4 creates them. That's expected; don't run typecheck standalone after this step, only after Task 5 wires both in. For now, just confirm the file parses by running the targeted test in the next step with those two imports temporarily commented out.

- [ ] **Step 3: Temporarily comment out the two new imports so this task is independently testable**

In the same import block, comment out the two lines that reference files that don't exist yet:

```tsx
// import { InviteMemberForm } from "./InviteMemberForm";
// import { PendingInvitationsTable } from "./PendingInvitationsTable";
```

(Task 4 and Task 5 will uncomment these as they add the real usage.)

- [ ] **Step 4: Run the existing team-page tests to confirm the refactor is behavior-preserving**

```bash
bun run test -- src/tests/team-page.test.tsx
```

Expected: all existing tests still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/features/team/roleOptions.ts src/features/team/TeamPage.tsx
git commit -m "$(cat <<'EOF'
refactor: extract company role vocabulary into roleOptions.ts

InviteMemberForm, PendingInvitationsTable and the accept-invite page
all need the same role labels TeamPage.tsx already defines. Pulling it
into one module now avoids three copies drifting apart later.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Client-safe token preview

**Files:**
- Modify: `src/workflows/companyInvitations.ts`

`previewCompanyInvitationByToken` (already built) uses the **service-role client** directly and is a plain async function, not a `createServerFn`. Every other function in this file that touches Supabase is wrapped in `createServerFn`, which is what keeps the actual client construction server-only when React components import this module — a plain function does not get that protection. The accept-invite page must not call `previewCompanyInvitationByToken` directly; it needs a thin server-fn wrapper.

- [ ] **Step 1: Add the wrapper at the end of `src/workflows/companyInvitations.ts`**

Find the end of the file:

```ts
  return {
    companyName: row.companies?.name ?? "this company",
    email: row.email,
    role: row.role,
    status: displayStatus({
      status: row.status,
      expires_at: row.expires_at,
    } as CompanyInvitationRow),
  };
}
```

Add immediately after it:

```ts

const previewCompanyInvitationSchema = z.object({ token: z.string().min(1) });

/**
 * Client-safe entry point for previewCompanyInvitationByToken() above: that
 * function uses the service-role client directly, so it must never execute
 * in the browser. Every other exported function in this file is safe for a
 * React component to call because createServerFn keeps the handler body
 * server-only; this is the same protection, just wrapped around the
 * existing function instead of duplicating its logic. AcceptInvitePage
 * calls this export, never previewCompanyInvitationByToken directly.
 */
export const previewCompanyInvitation = createServerFn({ method: "GET" })
  .validator(previewCompanyInvitationSchema)
  .handler(({ data }) => previewCompanyInvitationByToken(data.token));
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/workflows/companyInvitations.ts
git commit -m "$(cat <<'EOF'
feat: add a client-safe server-fn wrapper for invitation token preview

previewCompanyInvitationByToken() uses the service-role client and must
stay server-only. Wrapping it in createServerFn (previewCompanyInvitation)
gives the upcoming accept-invite route a safe way to call it, matching
how every other Supabase-touching export in this file is protected.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Invite form

**Files:**
- Create: `src/features/team/InviteMemberForm.tsx`
- Modify: `src/features/team/TeamPage.tsx`
- Test: `src/tests/team-page.test.tsx`

- [ ] **Step 1: Write the failing test**

In `src/tests/team-page.test.tsx`, extend the `companyInvitations` mock and add a test. Find:

```tsx
const changeCompanyMemberRole = vi.fn(async () => ({}));
const removeCompanyMember = vi.fn(async () => ({ status: "removed" }));
const transferCompanyOwnership = vi.fn(async () => ({ status: "transferred" }));

vi.mock("@/workflows/companyInvitations", () => ({
  listCompanyMembers: vi.fn(async () => members),
  changeCompanyMemberRole: (...args: unknown[]) => changeCompanyMemberRole(...(args as [])),
  removeCompanyMember: (...args: unknown[]) => removeCompanyMember(...(args as [])),
  transferCompanyOwnership: (...args: unknown[]) => transferCompanyOwnership(...(args as [])),
}));
```

Replace with:

```tsx
const changeCompanyMemberRole = vi.fn(async () => ({}));
const removeCompanyMember = vi.fn(async () => ({ status: "removed" }));
const transferCompanyOwnership = vi.fn(async () => ({ status: "transferred" }));
const inviteCompanyMember = vi.fn(async () => ({
  invitation: {
    id: "inv-1",
    companyId: "c-1",
    email: "new@acme.test",
    role: "read_only",
    status: "pending",
    invitedByEmail: "owner@acme.test",
    resendCount: 0,
    createdAt: "2026-09-20T00:00:00Z",
    expiresAt: "2026-09-27T00:00:00Z",
    acceptedAt: null,
    revokedAt: null,
  },
  acceptUrl: "https://app.vendorclr.test/accept-invite/tok-abc",
  email: { status: "sent", to: "new@acme.test" },
}));
const listCompanyInvitations = vi.fn(async () => [] as unknown[]);
const resendCompanyInvitation = vi.fn(async () => ({}));
const revokeCompanyInvitation = vi.fn(async () => ({ status: "revoked" }));

vi.mock("@/workflows/companyInvitations", () => ({
  listCompanyMembers: vi.fn(async () => members),
  changeCompanyMemberRole: (...args: unknown[]) => changeCompanyMemberRole(...(args as [])),
  removeCompanyMember: (...args: unknown[]) => removeCompanyMember(...(args as [])),
  transferCompanyOwnership: (...args: unknown[]) => transferCompanyOwnership(...(args as [])),
  inviteCompanyMember: (...args: unknown[]) => inviteCompanyMember(...(args as [])),
  listCompanyInvitations: (...args: unknown[]) => listCompanyInvitations(...(args as [])),
  resendCompanyInvitation: (...args: unknown[]) => resendCompanyInvitation(...(args as [])),
  revokeCompanyInvitation: (...args: unknown[]) => revokeCompanyInvitation(...(args as [])),
}));
```

Then add this test inside `describe("team page", ...)`, after the existing "lets an owner change a teammate's role" test:

```tsx
  it("lets an owner invite a teammate and shows the invitation link", async () => {
    await renderTeam();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "new@acme.test");
    await user.selectOptions(screen.getByLabelText("Role"), "read_only");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => {
      expect(inviteCompanyMember).toHaveBeenCalledWith({
        data: { companyId: "c-1", email: "new@acme.test", role: "read_only" },
      });
    });
    expect(await screen.findByText("Invitation emailed to new@acme.test.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "https://app.vendorclr.test/accept-invite/tok-abc" }),
    ).toBeInTheDocument();
  });

  it("hides the invite form from a non-owner", async () => {
    membership = { company_id: "c-1", role: "read_only" };
    await renderTeam();

    await screen.findByText("eng@acme.test");
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test -- src/tests/team-page.test.tsx
```

Expected: FAIL — `InviteMemberForm` doesn't exist yet and `TeamPage.tsx`'s import for it is still commented out.

- [ ] **Step 3: Create `src/features/team/InviteMemberForm.tsx`**

```tsx
import { useState, type FormEvent } from "react";

import { inviteCompanyMember, type CompanyMemberRole } from "@/workflows/companyInvitations";
import { ROLE_OPTIONS } from "./roleOptions";

interface InviteMemberFormProps {
  companyId: string;
  onInvited: () => void;
}

const inputClass =
  "focusable w-full rounded-sm border border-input bg-card px-3 py-2 text-sm text-foreground";
const submitClass =
  "focusable rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60";

type EmailStatus = "sent" | "failed" | "not_configured" | "suppressed";

function emailStatusMessage(email: string, status: EmailStatus): string {
  switch (status) {
    case "sent":
      return `Invitation emailed to ${email}.`;
    case "not_configured":
      return `Invitation created for ${email}. Email sending isn't configured yet — share the link below directly.`;
    case "suppressed":
      return `Invitation created for ${email}, but that address has opted out of email. Share the link below directly.`;
    case "failed":
      return `Invitation created for ${email}, but the email could not be sent. Share the link below directly.`;
  }
}

/**
 * Owner-only invite affordance. Always shows the acceptUrl inviteCompanyMember()
 * returns, even when the email sent successfully - the same graceful-degradation
 * link the workflow layer already builds for a not_configured/failed/suppressed
 * send, useful here for an owner who wants to share it another way (Slack, etc.)
 * regardless of send status.
 */
export function InviteMemberForm({ companyId, onInvited }: InviteMemberFormProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CompanyMemberRole>("read_only");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    setAcceptUrl(null);
    try {
      const result = await inviteCompanyMember({ data: { companyId, email, role } });
      setNotice(emailStatusMessage(result.email.to, result.email.status));
      setAcceptUrl(result.acceptUrl);
      setEmail("");
      setRole("read_only");
      onInvited();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send the invitation. Try again.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">Invite a teammate</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1 space-y-1.5">
          <label htmlFor="invite-email" className="block text-xs font-medium text-foreground">
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            disabled={pending}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="invite-role" className="block text-xs font-medium text-foreground">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            disabled={pending}
            onChange={(event) => setRole(event.target.value as CompanyMemberRole)}
            className="focusable rounded-sm border border-input bg-card px-2 py-2 text-sm"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending} className={submitClass}>
          {pending ? "Sending…" : "Send invitation"}
        </button>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <div role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
          <p>{notice}</p>
          {acceptUrl ? (
            <p className="mt-1 break-all">
              Invitation link:{" "}
              <a href={acceptUrl} className="font-medium text-primary underline">
                {acceptUrl}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
```

- [ ] **Step 4: Wire it into `TeamPage.tsx`**

Uncomment the import added in Task 2:

```tsx
import { InviteMemberForm } from "./InviteMemberForm";
// import { PendingInvitationsTable } from "./PendingInvitationsTable";
```

Find:

```tsx
            {!isOwner ? (
              <p role="note" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                Only an owner can change roles or remove people. You can see who is on the team.
              </p>
            ) : null}
            {error ? (
```

Replace with:

```tsx
            {!isOwner ? (
              <p role="note" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                Only an owner can change roles or remove people. You can see who is on the team.
              </p>
            ) : null}
            {isOwner ? (
              <InviteMemberForm
                companyId={companyId as string}
                onInvited={() =>
                  void queryClient.invalidateQueries({ queryKey: ["team-invitations", companyId] })
                }
              />
            ) : null}
            {error ? (
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun run test -- src/tests/team-page.test.tsx
```

Expected: PASS, including the two new tests. (The "hides the invite form from a non-owner" test will pass; the pending-invitations behavior is Task 5's job.)

- [ ] **Step 6: Commit**

```bash
git add src/features/team/InviteMemberForm.tsx src/features/team/TeamPage.tsx src/tests/team-page.test.tsx
git commit -m "$(cat <<'EOF'
feat: add owner-only invite-teammate form to the Team page

Calls the already-built inviteCompanyMember() workflow. Always shows
the returned accept link regardless of email-send status, matching the
workflow's existing graceful-degradation shape when Resend isn't
configured or the send fails/is suppressed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Pending invitations table

**Files:**
- Create: `src/features/team/PendingInvitationsTable.tsx`
- Modify: `src/features/team/TeamPage.tsx`
- Test: `src/tests/team-page.test.tsx`

- [ ] **Step 1: Write the failing test**

In `src/tests/team-page.test.tsx`, replace the placeholder invitations mocks with real fixture data, and add tests. Find:

```tsx
const listCompanyInvitations = vi.fn(async () => [] as unknown[]);
const resendCompanyInvitation = vi.fn(async () => ({}));
const revokeCompanyInvitation = vi.fn(async () => ({ status: "revoked" }));
```

Replace with:

```tsx
const invitations = [
  {
    id: "inv-1",
    companyId: "c-1",
    email: "pending@acme.test",
    role: "project_engineer",
    status: "pending",
    invitedByEmail: "owner@acme.test",
    resendCount: 0,
    createdAt: "2026-09-15T00:00:00Z",
    expiresAt: "2026-09-22T00:00:00Z",
    acceptedAt: null,
    revokedAt: null,
  },
  {
    id: "inv-2",
    companyId: "c-1",
    email: "already-joined@acme.test",
    role: "read_only",
    status: "accepted",
    invitedByEmail: "owner@acme.test",
    resendCount: 0,
    createdAt: "2026-09-10T00:00:00Z",
    expiresAt: "2026-09-17T00:00:00Z",
    acceptedAt: "2026-09-11T00:00:00Z",
    revokedAt: null,
  },
];
const listCompanyInvitations = vi.fn(async () => invitations);
const resendCompanyInvitation = vi.fn(async () => ({}));
const revokeCompanyInvitation = vi.fn(async () => ({ status: "revoked" }));
```

Then add these tests after the invite-form tests added in Task 4 (add `within` to the `@testing-library/react` import at the top of the file first — find `import { render, screen, waitFor } from "@testing-library/react";` and replace with `import { render, screen, waitFor, within } from "@testing-library/react";`):

```tsx
  it("shows pending invitations and lets an owner resend", async () => {
    await renderTeam();
    const user = userEvent.setup();

    expect(await screen.findByText("pending@acme.test")).toBeInTheDocument();
    const pendingRow = screen.getByText("pending@acme.test").closest("tr")!;
    await user.click(within(pendingRow).getByRole("button", { name: "Resend" }));

    await waitFor(() => {
      expect(resendCompanyInvitation).toHaveBeenCalledWith({ data: { invitationId: "inv-1" } });
    });
  });

  it("lets an owner revoke a pending invitation after confirming", async () => {
    // jsdom's window.confirm returns false by default; the revoke button
    // asks before calling through, same as Remove/Make owner elsewhere on
    // this page, so the confirm dialog must be stubbed to proceed.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderTeam();
    const user = userEvent.setup();

    const pendingRow = (await screen.findByText("pending@acme.test")).closest("tr")!;
    await user.click(within(pendingRow).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(revokeCompanyInvitation).toHaveBeenCalledWith({ data: { invitationId: "inv-1" } });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Invitation to pending@acme.test was revoked.",
    );
  });

  it("only shows resend/revoke actions for genuinely pending invitations", async () => {
    await renderTeam();

    await screen.findByText("already-joined@acme.test");
    const acceptedRow = screen.getByText("already-joined@acme.test").closest("tr")!;
    expect(within(acceptedRow).queryByRole("button", { name: "Resend" })).not.toBeInTheDocument();
    expect(within(acceptedRow).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("hides pending invitations from a non-owner", async () => {
    membership = { company_id: "c-1", role: "read_only" };
    await renderTeam();

    await screen.findByText("eng@acme.test");
    expect(screen.queryByText("Pending invitations")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test -- src/tests/team-page.test.tsx
```

Expected: FAIL — `PendingInvitationsTable` doesn't exist yet.

- [ ] **Step 3: Create `src/features/team/PendingInvitationsTable.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  listCompanyInvitations,
  resendCompanyInvitation,
  revokeCompanyInvitation,
  type CompanyInvitation,
} from "@/workflows/companyInvitations";
import { roleLabel } from "./roleOptions";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

const buttonClass =
  "focusable rounded-sm border border-input bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-60";

const STATUS_LABEL: Record<CompanyInvitation["status"], string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};

/**
 * Owner-only. Resend/revoke only render for a row whose *computed* status
 * (expiry-aware, from listCompanyInvitations()) is genuinely 'pending' -
 * expired, revoked and accepted rows are display-only, so a dead link never
 * looks actionable.
 */
export function PendingInvitationsTable({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invitations = useQuery({
    queryKey: ["team-invitations", companyId],
    queryFn: () => listCompanyInvitations({ data: { companyId } }),
  });

  const finish = (message: string) => {
    setError(null);
    setNotice(message);
    void queryClient.invalidateQueries({ queryKey: ["team-invitations", companyId] });
  };
  const fail = (cause: unknown) => {
    setNotice(null);
    setError(errorMessage(cause));
  };

  const resend = useMutation({
    mutationFn: (invitation: CompanyInvitation) =>
      resendCompanyInvitation({ data: { invitationId: invitation.id } }),
    onSuccess: (_result, invitation) => finish(`Invitation resent to ${invitation.email}.`),
    onError: fail,
  });

  const revoke = useMutation({
    mutationFn: (invitation: CompanyInvitation) =>
      revokeCompanyInvitation({ data: { invitationId: invitation.id } }),
    onSuccess: (_result, invitation) => finish(`Invitation to ${invitation.email} was revoked.`),
    onError: fail,
  });

  const busy = resend.isPending || revoke.isPending;
  const rows = invitations.data ?? [];

  if (invitations.isLoading) {
    return <LoadingState label="Loading pending invitations" rows={2} />;
  }
  if (invitations.isError) {
    return (
      <ErrorState
        title="Could not load pending invitations"
        description={errorMessage(invitations.error)}
        onRetry={() => void invitations.refetch()}
      />
    );
  }
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">Pending invitations</h2>
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-sm border border-border bg-muted px-3 py-2 text-xs">
          {notice}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Pending and past invitations</caption>
          <thead className="border-b border-border bg-muted text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Email
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Role
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Invited by
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Sent
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Expires
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((invitation) => (
              <tr key={invitation.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-medium">{invitation.email}</td>
                <td className="px-3 py-2">{roleLabel(invitation.role)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {invitation.invitedByEmail ?? "Unknown"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {invitation.createdAt.slice(0, 10)}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {invitation.expiresAt.slice(0, 10)}
                </td>
                <td className="px-3 py-2 text-xs">{STATUS_LABEL[invitation.status]}</td>
                <td className="px-3 py-2">
                  {invitation.status === "pending" ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass}
                        onClick={() => resend.mutate(invitation)}
                      >
                        Resend
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass}
                        onClick={() => {
                          if (window.confirm(`Revoke the invitation to ${invitation.email}?`)) {
                            revoke.mutate(invitation);
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `TeamPage.tsx`**

Uncomment the second import:

```tsx
import { InviteMemberForm } from "./InviteMemberForm";
import { PendingInvitationsTable } from "./PendingInvitationsTable";
```

Find the block added in Task 4:

```tsx
            {isOwner ? (
              <InviteMemberForm
                companyId={companyId as string}
                onInvited={() =>
                  void queryClient.invalidateQueries({ queryKey: ["team-invitations", companyId] })
                }
              />
            ) : null}
            {error ? (
```

Replace with:

```tsx
            {isOwner ? (
              <InviteMemberForm
                companyId={companyId as string}
                onInvited={() =>
                  void queryClient.invalidateQueries({ queryKey: ["team-invitations", companyId] })
                }
              />
            ) : null}
            {isOwner ? <PendingInvitationsTable companyId={companyId as string} /> : null}
            {error ? (
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun run test -- src/tests/team-page.test.tsx
```

Expected: PASS, all tests including the three new ones.

- [ ] **Step 6: Typecheck the whole project**

```bash
bun run typecheck
```

Expected: clean. (This is the first point where `TeamPage.tsx`'s two previously-commented imports are both live.)

- [ ] **Step 7: Commit**

```bash
git add src/features/team/PendingInvitationsTable.tsx src/features/team/TeamPage.tsx src/tests/team-page.test.tsx
git commit -m "$(cat <<'EOF'
feat: show pending invitations on the Team page with resend/revoke

Owner-only, reusing listCompanyInvitations()/resendCompanyInvitation()/
revokeCompanyInvitation(). Only rows whose computed status is genuinely
pending show resend/revoke - expired, revoked and accepted rows are
display-only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Preserve invitation state through sign-up

**Files:**
- Modify: `src/routes/signup.tsx`
- Modify: `src/features/auth/AuthPages.tsx`
- Test: `src/tests/signup-redirect.test.tsx` (new)

`/login` already supports `?redirect=` so a signed-out visitor returns to where they started. `/signup` does not — a brand-new invitee would land on `/demo` after creating an account, losing the invitation. This gives `/signup` the same, already-validated same-origin-only `redirect` mechanism.

- [ ] **Step 1: Write the failing test**

Create `src/tests/signup-redirect.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SignupPage } from "@/features/auth/AuthPages";

/**
 * SignupPage reads ?redirect= the same way LoginPage does, so a signup
 * started from a flow like accept-invite can resume there instead of
 * always landing on /demo.
 */

let search: { redirect?: string } = {};
const navigate = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigate,
    useSearch: () => search,
    // AuthLayout's footer renders a real <Link to="/login">, which otherwise
    // needs a RouterProvider context this test doesn't set up. A plain
    // anchor is enough - nothing here asserts on it.
    Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  };
});

const signUp = vi.fn(async () => ({ data: { session: { user: {} } }, error: null }));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({ auth: { signUp: (...args: unknown[]) => signUp(...(args as [])) } }),
}));

vi.mock("@/lib/supabase/env", () => ({ hasBackendEnv: () => true }));

function renderSignup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>{(<SignupPage />) as ReactNode}</QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  search = {};
});

describe("signup redirect", () => {
  it("uses the default destination when no redirect is present", async () => {
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Work email"), "new@acme.test");
    await user.type(screen.getByLabelText(/Password/), "supersecretpassword");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            emailRedirectTo: expect.stringContaining("/demo"),
          }),
        }),
      );
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/demo" });
  });

  it("resumes at the redirect target after signup when one is present", async () => {
    search = { redirect: "/accept-invite/tok-abc" };
    renderSignup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Work email"), "invitee@acme.test");
    await user.type(screen.getByLabelText(/Password/), "supersecretpassword");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            emailRedirectTo: expect.stringContaining("/accept-invite/tok-abc"),
          }),
        }),
      );
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/accept-invite/tok-abc" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test -- src/tests/signup-redirect.test.tsx
```

Expected: FAIL — `SignupPage` doesn't read `search.redirect` yet, so both assertions on the destination fail.

- [ ] **Step 3: Add `validateSearch` to `src/routes/signup.tsx`**

Find:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/signup")({
  head: () => ({
```

Replace with:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/signup")({
  // Same same-origin-only guard as /login's redirect (see src/routes/login.tsx),
  // reused so a signup started from a flow like accept-invite can land back
  // where it began instead of always landing on /demo.
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const raw = search["redirect"];
    return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
      ? { redirect: raw }
      : {};
  },
  head: () => ({
```

- [ ] **Step 4: Update `SignupPage` in `src/features/auth/AuthPages.tsx`**

Find:

```tsx
export function SignupPage() {
  const navigate = useNavigate();
  const live = hasBackendEnv();

  const { notice, error, pending, onSubmit } = useAuthForm(async (form) => {
    // Sign-up is open: an account is created with no company attached, and the
    // handle_new_user() trigger creates the profile only. The workspace itself
    // arrives later, when an activation code is redeemed on the demo screen -
    // redeem_activation_code() is what creates the company and the owner seat,
    // in one transaction. So a fresh account lands on /demo, not /dashboard.
    const { data, error: signUpError } = await getSupabaseClient().auth.signUp({
      email: text(form, "signup-email"),
      password: String(form.get("signup-password") ?? ""),
      options: {
        data: {
          full_name: text(form, "full-name"),
        },
        // Without this, Supabase falls back to the project's Site URL setting
        // to build the confirmation link - which is a project-level default
        // most likely wrong for any deploy that isn't the one the project was
        // first configured against. Set explicitly here, same as
        // resetPasswordForEmail() below, so the link always lands back on
        // whichever origin the signup actually happened from.
        emailRedirectTo: `${window.location.origin}/demo`,
      },
    });
    if (signUpError) throw new Error(signUpError.message);

    if (data.session) {
      await navigate({ to: "/demo" });
      return "Account created.";
    }
    return "Check your email to confirm the account, then sign in.";
  });
```

Replace with:

```tsx
export function SignupPage() {
  const navigate = useNavigate();
  const live = hasBackendEnv();
  // Set when signup was reached from a flow like accept-invite that needs to
  // resume after account creation. Already validated as a same-origin
  // relative path by the route's validateSearch.
  const search = useSearch({ strict: false }) as { redirect?: string };
  const destination = (search.redirect ?? "/demo") as "/demo";

  const { notice, error, pending, onSubmit } = useAuthForm(async (form) => {
    // Sign-up is open: an account is created with no company attached, and the
    // handle_new_user() trigger creates the profile only. The workspace itself
    // arrives later, when an activation code is redeemed on the demo screen -
    // redeem_activation_code() is what creates the company and the owner seat,
    // in one transaction. So a fresh account lands on /demo by default -
    // unless `destination` says otherwise, e.g. accept-invite sending someone
    // back to finish accepting an invitation instead.
    const { data, error: signUpError } = await getSupabaseClient().auth.signUp({
      email: text(form, "signup-email"),
      password: String(form.get("signup-password") ?? ""),
      options: {
        data: {
          full_name: text(form, "full-name"),
        },
        // Without this, Supabase falls back to the project's Site URL setting
        // to build the confirmation link - which is a project-level default
        // most likely wrong for any deploy that isn't the one the project was
        // first configured against. Set explicitly here, same as
        // resetPasswordForEmail() below, so the link always lands back on
        // whichever origin the signup actually happened from, and on
        // `destination` rather than always /demo.
        emailRedirectTo: `${window.location.origin}${destination}`,
      },
    });
    if (signUpError) throw new Error(signUpError.message);

    if (data.session) {
      await navigate({ to: destination });
      return "Account created.";
    }
    return "Check your email to confirm the account, then sign in.";
  });
```

(`useSearch` is already imported at the top of this file — `LoginPage` uses it.)

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun run test -- src/tests/signup-redirect.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

```bash
bun run typecheck
bun run test
```

Expected: clean — this change is additive and defaults to prior behavior when no `redirect` is present.

- [ ] **Step 7: Commit**

```bash
git add src/routes/signup.tsx src/features/auth/AuthPages.tsx src/tests/signup-redirect.test.tsx
git commit -m "$(cat <<'EOF'
feat: let signup resume at a redirect target instead of always /demo

Mirrors /login's existing same-origin-validated ?redirect= so a brand
new invitee who signs up from the accept-invite page lands back there
to finish accepting, instead of losing the invitation on /demo.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Register the accept-invite route

**Files:**
- Modify: `src/app/router.tsx`
- Create: `src/routes/accept-invite.$token.tsx`
- Modify (generated): `src/routeTree.gen.ts`

This task only wires the route shell (a placeholder component); Task 8 builds the real page. Splitting it out isolates the route-registration/build step, which is the part most likely to need a rebuild to regenerate `routeTree.gen.ts`.

- [ ] **Step 1: Add the route constant to `src/app/router.tsx`**

Find:

```tsx
export const routes = {
  login: "/login",
  signup: "/signup",
  resetPassword: "/reset-password",
  /** Read-only sample console for accounts that have not been activated yet. */
  demo: "/demo",
  dashboard: "/dashboard",
```

Replace with:

```tsx
export const routes = {
  login: "/login",
  signup: "/signup",
  resetPassword: "/reset-password",
  /** Read-only sample console for accounts that have not been activated yet. */
  demo: "/demo",
  /** Public link a teammate receives by email. Not in customerNav - nothing in-app links to it. */
  acceptInvite: "/accept-invite/$token",
  dashboard: "/dashboard",
```

- [ ] **Step 2: Create a placeholder component so the route file has something to render**

Create `src/features/team/AcceptInvitePage.tsx` with a minimal placeholder (Task 8 replaces this body):

```tsx
export function AcceptInvitePage({ token }: { token: string }) {
  return <p>Loading invitation for {token}…</p>;
}
```

- [ ] **Step 3: Create `src/routes/accept-invite.$token.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { AcceptInvitePage } from "@/features/team/AcceptInvitePage";

/**
 * Public route: the link a teammate receives by email. No AppShell, no auth
 * guard - AcceptInvitePage itself decides what an unauthenticated, wrongly
 * authenticated, or correctly authenticated visitor sees.
 */
export const Route = createFileRoute("/accept-invite/$token")({
  head: () => ({
    meta: [
      { title: "Accept invitation — VendorClr" },
      { name: "description", content: "Accept an invitation to join a company on VendorClr." },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AcceptInviteRoute,
});

function AcceptInviteRoute() {
  const { token } = Route.useParams();
  return <AcceptInvitePage token={token} />;
}
```

- [ ] **Step 4: Regenerate `src/routeTree.gen.ts`**

The route tree is generated by the `@tanstack/router-plugin` vite plugin during `vite build`/`vite dev`, not by a standalone CLI in this project. Run a build to regenerate it:

```bash
bun run build
```

Expected: the build succeeds and `src/routeTree.gen.ts` now contains an entry for `/accept-invite/$token` (e.g. `AcceptInviteTokenRouteImport` or similar, alongside the existing `VendorUploadTokenRouteImport`). Confirm with:

```bash
grep -c "accept-invite" src/routeTree.gen.ts
```

Expected: a non-zero count.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit (including the generated file)**

```bash
git add src/app/router.tsx src/routes/accept-invite.\$token.tsx src/features/team/AcceptInvitePage.tsx src/routeTree.gen.ts
git commit -m "$(cat <<'EOF'
feat: register the /accept-invite/\$token route

Placeholder component for now - Task 8 builds the real page. Splitting
route registration out isolates the routeTree.gen.ts regeneration step.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Accept-invite page

**Files:**
- Modify: `src/features/team/AcceptInvitePage.tsx`
- Test: `src/tests/accept-invite.test.tsx` (new)

Covers every state from the spec: invalid token, revoked, expired, already-accepted, unauthenticated (with preserved redirect), wrong email, correct email (accept + success), and a failed accept (e.g. replay).

- [ ] **Step 1: Write the failing tests**

Create `src/tests/accept-invite.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcceptInvitePage } from "@/features/team/AcceptInvitePage";

/**
 * Every state the accept-invite route must handle. An invalid/unknown token
 * and every other kind of "won't work" case (expired/revoked/accepted) must
 * not be distinguishable from each other before a real, matching invitation
 * is found - only once previewCompanyInvitation() actually returns a row
 * (proving the token is real) do the specific states differ.
 */

interface SessionMock {
  status: "loading" | "authenticated" | "anonymous";
  email: string | null;
  signOut: () => Promise<void>;
}

let sessionMock: SessionMock;
const signOut = vi.fn(async () => {});
const navigate = vi.fn();

vi.mock("@/app/App", () => ({
  useSession: () => sessionMock,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({
      to,
      search,
      children,
    }: {
      to: string;
      search?: { redirect?: string };
      children: ReactNode;
    }) => <a href={`${to}${search?.redirect ? `?redirect=${search.redirect}` : ""}`}>{children}</a>,
  };
});

const previewCompanyInvitation = vi.fn();
const acceptCompanyInvitation = vi.fn();

vi.mock("@/workflows/companyInvitations", () => ({
  previewCompanyInvitation: (...args: unknown[]) => previewCompanyInvitation(...(args as [])),
  acceptCompanyInvitation: (...args: unknown[]) => acceptCompanyInvitation(...(args as [])),
  INVITATION_TTL_DAYS: 7,
}));

const PENDING_INVITE = {
  companyName: "Acme Co",
  email: "invitee@acme.test",
  role: "project_engineer" as const,
  status: "pending" as const,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AcceptInvitePage token="tok-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("accept-invite page", () => {
  it("shows a generic message for an unknown token", async () => {
    previewCompanyInvitation.mockResolvedValue(null);
    sessionMock = { status: "anonymous", email: null, signOut };
    renderPage();

    expect(await screen.findByText("This invitation link isn't valid")).toBeInTheDocument();
  });

  it("does not distinguish an unknown token from any other reason a link might not work", async () => {
    previewCompanyInvitation.mockResolvedValue(null);
    sessionMock = { status: "anonymous", email: null, signOut };
    renderPage();

    expect(await screen.findByText("This invitation link isn't valid")).toBeInTheDocument();
    expect(screen.queryByText(/expired|revoked|already used/i)).not.toBeInTheDocument();
  });

  it("shows a distinct state for a revoked invitation", async () => {
    previewCompanyInvitation.mockResolvedValue({ ...PENDING_INVITE, status: "revoked" });
    sessionMock = { status: "anonymous", email: null, signOut };
    renderPage();

    expect(await screen.findByText("This invitation was revoked")).toBeInTheDocument();
  });

  it("shows a distinct state for an expired invitation", async () => {
    previewCompanyInvitation.mockResolvedValue({ ...PENDING_INVITE, status: "expired" });
    sessionMock = { status: "anonymous", email: null, signOut };
    renderPage();

    expect(await screen.findByText("This invitation has expired")).toBeInTheDocument();
  });

  it("shows a distinct state for an already-accepted invitation", async () => {
    previewCompanyInvitation.mockResolvedValue({ ...PENDING_INVITE, status: "accepted" });
    sessionMock = { status: "anonymous", email: null, signOut };
    renderPage();

    expect(await screen.findByText("This invitation was already used")).toBeInTheDocument();
  });

  it("sends an unauthenticated visitor to sign in with the invitation preserved", async () => {
    previewCompanyInvitation.mockResolvedValue(PENDING_INVITE);
    sessionMock = { status: "anonymous", email: null, signOut };
    renderPage();

    const signInLink = await screen.findByRole("link", { name: "Sign in" });
    expect(signInLink).toHaveAttribute("href", expect.stringContaining("/accept-invite/tok-1"));
    const signUpLink = screen.getByRole("link", { name: "Create an account" });
    expect(signUpLink).toHaveAttribute("href", expect.stringContaining("/accept-invite/tok-1"));
  });

  it("rejects a signed-in account whose email does not match the invitation, without extra detail", async () => {
    previewCompanyInvitation.mockResolvedValue(PENDING_INVITE);
    sessionMock = { status: "authenticated", email: "someone-else@other.test", signOut };
    renderPage();

    expect(await screen.findByText("This invitation isn't for this account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
    expect(screen.queryByText("someone-else@other.test")).not.toBeInTheDocument();
  });

  it("lets the correct authenticated user accept and shows the joined role", async () => {
    previewCompanyInvitation.mockResolvedValue(PENDING_INVITE);
    acceptCompanyInvitation.mockResolvedValue({ companyId: "c-1", role: "project_engineer" });
    sessionMock = { status: "authenticated", email: "invitee@acme.test", signOut };
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("You've joined Acme Co")).toBeInTheDocument();
    expect(screen.getByText(/Project engineer/)).toBeInTheDocument();
    expect(acceptCompanyInvitation).toHaveBeenCalledWith({ data: { token: "tok-1" } });
  });

  it("shows an inline error when acceptance fails, e.g. a replayed link", async () => {
    previewCompanyInvitation.mockResolvedValue(PENDING_INVITE);
    acceptCompanyInvitation.mockRejectedValue(
      new Error("This invitation link is no longer valid."),
    );
    sessionMock = { status: "authenticated", email: "invitee@acme.test", signOut };
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invitation link is no longer valid.",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun run test -- src/tests/accept-invite.test.tsx
```

Expected: FAIL — the placeholder component doesn't render any of this.

- [ ] **Step 3: Replace `src/features/team/AcceptInvitePage.tsx` with the real implementation**

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { useSession } from "@/app/App";
import { routes } from "@/app/router";
import { ErrorState, LoadingState } from "@/components/states/AsyncState";
import {
  acceptCompanyInvitation,
  previewCompanyInvitation,
  INVITATION_TTL_DAYS,
} from "@/workflows/companyInvitations";
import { roleLabel } from "./roleOptions";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <img src="/vendorclr-logo-black.svg" alt="VendorClr" className="h-5 w-auto" />
        <div className="mt-3 rounded-md border border-border bg-card p-6">{children}</div>
      </div>
    </div>
  );
}

/**
 * Every state a teammate can land in from the emailed invitation link.
 *
 * previewCompanyInvitation() only returns null for a token that matches no
 * row at all (never existed, or was guessed) - a real invitation, whatever
 * its status, always comes back with its actual status. That is the anti-
 * enumeration line: guessing narrows nothing (uniform null), but holding
 * the real token from a real email already told you it exists, so the
 * specific expired/revoked/accepted copy below leaks nothing new.
 */
export function AcceptInvitePage({ token }: { token: string }) {
  const navigate = useNavigate();
  const session = useSession();
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["invitation-preview", token],
    queryFn: () => previewCompanyInvitation({ data: { token } }),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => acceptCompanyInvitation({ data: { token } }),
    onError: (cause) =>
      setAcceptError(
        cause instanceof Error ? cause.message : "This invitation is no longer valid.",
      ),
  });

  if (preview.isLoading) {
    return (
      <Shell>
        <LoadingState label="Loading your invitation" rows={2} />
      </Shell>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <Shell>
        <ErrorState
          title="This invitation link isn't valid"
          description="It may have been mistyped, or the invitation no longer exists. Ask whoever invited you to send a new one."
        />
      </Shell>
    );
  }

  const invite = preview.data;

  if (invite.status === "revoked") {
    return (
      <Shell>
        <ErrorState
          title="This invitation was revoked"
          description={`Whoever invited you to ${invite.companyName} has withdrawn this invitation. Ask them for a new one if this was unexpected.`}
        />
      </Shell>
    );
  }

  if (invite.status === "expired") {
    return (
      <Shell>
        <ErrorState
          title="This invitation has expired"
          description={`Invitations to join ${invite.companyName} expire after ${INVITATION_TTL_DAYS} days. Ask whoever invited you to send a new one.`}
        />
      </Shell>
    );
  }

  if (invite.status === "accepted") {
    return (
      <Shell>
        <ErrorState
          title="This invitation was already used"
          description={`This invitation to join ${invite.companyName} has already been accepted. Sign in to your account instead.`}
        />
      </Shell>
    );
  }

  if (accept.isSuccess) {
    return (
      <Shell>
        <h1 className="text-lg font-bold tracking-tight text-foreground">
          You've joined {invite.companyName}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You're in as {roleLabel(accept.data.role)}.
        </p>
        <button
          type="button"
          onClick={() => void navigate({ to: routes.dashboard })}
          className="focusable mt-4 w-full rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
        >
          Go to your dashboard
        </button>
      </Shell>
    );
  }

  if (session.status !== "authenticated") {
    const redirect = `/accept-invite/${token}`;
    return (
      <Shell>
        <h1 className="text-lg font-bold tracking-tight text-foreground">
          Join {invite.companyName} on VendorClr
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in with <span className="font-medium text-foreground">{invite.email}</span> to
          accept this invitation as {roleLabel(invite.role)}.
        </p>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link
            to="/login"
            search={{ redirect }}
            className="focusable rounded-sm bg-primary px-3 py-2 font-semibold text-primary-foreground"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            search={{ redirect }}
            className="focusable rounded-sm border border-input bg-card px-3 py-2 font-semibold text-foreground"
          >
            Create an account
          </Link>
        </div>
      </Shell>
    );
  }

  const sessionEmail = session.email?.trim().toLowerCase() ?? null;
  const inviteEmail = invite.email.trim().toLowerCase();

  if (sessionEmail !== inviteEmail) {
    return (
      <Shell>
        <h1 className="text-lg font-bold tracking-tight text-foreground">
          This invitation isn't for this account
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This invitation was sent to a different email address. Sign out and sign back in with
          the address it was sent to, then open the link again.
        </p>
        <button
          type="button"
          onClick={() => void session.signOut()}
          className="focusable mt-4 rounded-sm border border-input bg-card px-3 py-2 text-sm font-semibold text-foreground"
        >
          Sign out
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-lg font-bold tracking-tight text-foreground">
        Join {invite.companyName} on VendorClr
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        You're signed in as {invite.email}. Accept to join as {roleLabel(invite.role)}.
      </p>
      {acceptError ? (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
        >
          {acceptError}
        </p>
      ) : null}
      <button
        type="button"
        disabled={accept.isPending}
        onClick={() => accept.mutate()}
        className="focusable mt-4 w-full rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        {accept.isPending ? "Joining…" : "Accept invitation"}
      </button>
    </Shell>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun run test -- src/tests/accept-invite.test.tsx
```

Expected: PASS, all nine tests.

- [ ] **Step 5: Typecheck and run the full suite**

```bash
bun run typecheck
bun run test
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/team/AcceptInvitePage.tsx src/tests/accept-invite.test.tsx
git commit -m "$(cat <<'EOF'
feat: build the /accept-invite/\$token acceptance page

Handles invalid-token, revoked, expired, already-accepted,
unauthenticated (with preserved redirect through login/signup), wrong-
account, correct-account accept, and a failed-accept state (e.g.
replay) - all driven by previewCompanyInvitation() and
acceptCompanyInvitation(). Client-side email matching is UX only; the
real check stays in accept_company_invitation().

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Remove the legacy disabled invite control

**Files:**
- Modify: `src/features/admin/AccessPage.tsx`
- Modify: `src/tests/production-action-truth.test.tsx`

Per the approved design decision: `/dashboard/admin/access` has an "Invite teammate" button permanently disabled in production, unrelated to `company_invitations`. Now that the real flow exists on `/dashboard/team`, this stale, contradictory control is removed (the grants list itself is unrelated and stays).

- [ ] **Step 1: Update the test first**

In `src/tests/production-action-truth.test.tsx`, find:

```tsx
  it("does not present teammate invitations as available in production", async () => {
    renderWithQueryClient(<AccessPage />);

    expect(await main().findByText("No access grants")).toBeInTheDocument();
    expect(
      main().getByRole("button", { name: "Teammate invitations are not available" }),
    ).toBeDisabled();
    expect(main().queryByText(/demo/i)).not.toBeInTheDocument();
  });
```

Replace with:

```tsx
  it("does not present a broken teammate-invite control on the legacy access page", async () => {
    renderWithQueryClient(<AccessPage />);

    expect(await main().findByText("No access grants")).toBeInTheDocument();
    expect(main().queryByRole("button", { name: /invite/i })).not.toBeInTheDocument();
    expect(main().queryByText(/demo/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run it to verify it fails against the current component**

```bash
bun run test -- src/tests/production-action-truth.test.tsx
```

Expected: FAIL — the button is still present.

- [ ] **Step 3: Remove the invite control from `AccessPage.tsx`**

Replace the full contents of `src/features/admin/AccessPage.tsx` with:

```tsx
import { useQuery } from "@tanstack/react-query";
import { AdminGuard } from "./AdminGuard";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository, isBackendConfigured } from "@/data/repository";

export function AccessPage() {
  const repo = getRepository();
  const isDemo = !isBackendConfigured();
  const grants = useQuery({ queryKey: ["access"], queryFn: () => repo.listAccessGrants() });

  return (
    <AppShell
      title="Access management"
      subtitle={
        isDemo
          ? "Roles and project scopes. Demo mode — changes are not persisted."
          : "Roles and project scopes. Invite teammates from a company's own Team page."
      }
    >
      <AdminGuard>
        <div className="space-y-4">
          {grants.isLoading ? (
            <LoadingState label="Loading access grants" rows={4} />
          ) : grants.isError ? (
            <ErrorState
              description="Could not load access grants."
              onRetry={() => void grants.refetch()}
            />
          ) : (grants.data ?? []).length === 0 ? (
            <EmptyState title="No access grants" description="No one has access recorded yet." />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Access grants by person</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Person
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Role
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Scope
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Last active
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(grants.data ?? []).map((grant) => (
                    <tr key={grant.id} className="border-b border-border last:border-0">
                      <th scope="row" className="px-3 py-3 font-medium">
                        {grant.person}
                        <span className="block text-xs font-normal text-muted-foreground">
                          {grant.email}
                        </span>
                      </th>
                      <td className="px-3 py-3 text-xs">{grant.role}</td>
                      <td className="px-3 py-3 text-xs">{grant.scope}</td>
                      <td className="numeric px-3 py-3 text-xs">{grant.lastActiveOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </AdminGuard>
    </AppShell>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun run test -- src/tests/production-action-truth.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

```bash
bun run typecheck
bun run test
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/admin/AccessPage.tsx src/tests/production-action-truth.test.tsx
git commit -m "$(cat <<'EOF'
refactor: remove the legacy disabled invite control from AccessPage

Invitations now live on /dashboard/team, calling the real
company_invitations workflow. This staff-only screen's invite button
was permanently disabled and unrelated to that backend - leaving it in
place would contradict the working flow elsewhere in the app.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Documentation

**Files:**
- Modify: `roadmap.md`
- Modify: `docs/product/action-truth-inventory.md`

- [ ] **Step 1: Check off the roadmap item**

In `roadmap.md`, find:

```markdown
- [ ] Stage 2 — Teammate access UI + `/accept-invite/$token`
```

Replace with:

```markdown
- [x] Stage 2 — Teammate access UI + `/accept-invite/$token` (2026-09-22).
      Invite/pending-invitations UI on `/dashboard/team` (create, resend,
      revoke via `inviteCompanyMember`/`listCompanyInvitations`/
      `resendCompanyInvitation`/`revokeCompanyInvitation`) and the
      `/accept-invite/$token` acceptance route (unauthenticated,
      correct-email, wrong-email, expired, revoked, already-accepted,
      invalid-token and success states), both built entirely on the existing
      `company_invitations` backend and `src/workflows/companyInvitations.ts`
      from an earlier task. `/signup` now honors `?redirect=` so a brand-new
      invitee resumes at the invitation after creating an account. Legacy
      disabled invite control removed from `/dashboard/admin/access`.
```

- [ ] **Step 2: Add Team rows to the Customer operations table**

In `docs/product/action-truth-inventory.md`, find:

```markdown
| Tasks | Change visible priority filter | `live` | Local presentation filter only. |
| Help | Expand FAQ answers | `live` | Local disclosure action only. |
```

Replace with:

```markdown
| Tasks | Change visible priority filter | `live` | Local presentation filter only. |
| Help | Expand FAQ answers | `live` | Local disclosure action only. |
| Team | View team, change role, remove, transfer ownership | `live` | Reads/writes `company_members` via owner-checked security-definer RPCs (`change_company_member_role`, `remove_company_member`, `transfer_company_ownership`); a statement-level trigger blocks leaving a company with no active owner. |
| Team | Invite, view, resend and revoke invitations | `live` | Owner-only. `inviteCompanyMember`/`listCompanyInvitations`/`resendCompanyInvitation`/`revokeCompanyInvitation` call `company_invitations` and its security-definer RPCs; only genuinely pending invitations show resend/revoke. |
| Team | Accept an invitation (`/accept-invite/$token`) | `live` | Public route previews the invitation without a session (generic copy for an invalid/unknown token), then requires the signed-in account's email to match the invitation before calling `accept_company_invitation`. |
```

- [ ] **Step 3: Correct the stale Platform administration rows**

Find:

```markdown
| Access management | View access grants | `live` | Reads company memberships and profiles from the configured backend. |
| Access management | Invite teammate | `disabled` | No membership invitation backend workflow exists. Live UI says teammate invitations are not available; preview says no invitation was created or emailed. |
```

Replace with:

```markdown
| Access management | View access grants | `live` | Reads company memberships and profiles from the configured backend. The legacy disabled "Invite teammate" control on this screen was removed; invitations now live on the company's own Team page (see Customer operations above). |
```

- [ ] **Step 4: Commit**

```bash
git add roadmap.md docs/product/action-truth-inventory.md
git commit -m "$(cat <<'EOF'
docs: record teammate invitations UI as complete

roadmap.md's Stage 2 item is checked off and action-truth-inventory.md
is corrected: the stale "no invitation backend exists" line for the
legacy admin screen is replaced with the real, now-live Team page flow.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: End-to-end coverage

**Files:**
- Modify: `e2e/helpers.ts`
- Create: `e2e/team-invite.spec.ts`

The full owner-invites → teammate-accepts journey needs two real accounts on the environment under test: an **owner** of a company (to invite from), and an **invitee** whose email the test controls (to accept as). Both are credential-gated exactly like the existing `DEMO`/`MEMBER`/`STAFF` accounts — the spec skips itself when they're absent rather than weakening any gate, matching `e2e/role-flows.spec.ts`'s established pattern.

- [ ] **Step 1: Extend `credentials()` in `e2e/helpers.ts`**

Find:

```ts
/**
 * Credentials for the signed-in journeys. These are intentionally optional:
 * CI has no account on the production database, so the authenticated specs skip
 * themselves rather than inventing a session or weakening the access gate.
 *
 * Set in a GitHub environment to enable them:
 *   E2E_DEMO_EMAIL / E2E_DEMO_PASSWORD      - account with no activated workspace
 *   E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD  - member of an activated company
 *   E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD    - VendorClr staff account
 */
export function credentials(prefix: "DEMO" | "MEMBER" | "STAFF") {
  const email = process.env[`E2E_${prefix}_EMAIL`];
  const password = process.env[`E2E_${prefix}_PASSWORD`];
  return email && password ? { email, password } : null;
}
```

Replace with:

```ts
/**
 * Credentials for the signed-in journeys. These are intentionally optional:
 * CI has no account on the production database, so the authenticated specs skip
 * themselves rather than inventing a session or weakening the access gate.
 *
 * Set in a GitHub environment to enable them:
 *   E2E_DEMO_EMAIL / E2E_DEMO_PASSWORD        - account with no activated workspace
 *   E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD    - member of an activated company
 *   E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD      - VendorClr staff account
 *   E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD      - owner of an activated company (for the invite journey)
 *   E2E_INVITEE_EMAIL / E2E_INVITEE_PASSWORD  - a second, already-signed-up account the owner
 *                                                invites and that signs in to accept (no real
 *                                                inbox needed: InviteMemberForm always shows the
 *                                                accept link directly to the inviting owner)
 */
export function credentials(prefix: "DEMO" | "MEMBER" | "STAFF" | "OWNER" | "INVITEE") {
  const email = process.env[`E2E_${prefix}_EMAIL`];
  const password = process.env[`E2E_${prefix}_PASSWORD`];
  return email && password ? { email, password } : null;
}
```

- [ ] **Step 2: Create `e2e/team-invite.spec.ts`**

```ts
import { expect, test } from "@playwright/test";
import { credentials, isLiveBuild, signIn } from "./helpers";

/**
 * owner opens Team -> invites teammate -> teammate opens link -> signs in ->
 * accepts -> teammate appears in the member list.
 *
 * Needs E2E_OWNER_* (owner of a real, activated company) and E2E_INVITEE_*
 * (a second account already signed up on the same environment) - see
 * e2e/helpers.ts. Skips itself, like every other credential-gated spec in
 * this suite, rather than weakening the access gate to stay green.
 *
 * Cleans up after itself (removes the invitee from the company at the end)
 * so the test is safely re-runnable: create_company_invitation() rejects
 * inviting an email that is already an active member.
 */
test("owner invites a teammate, who signs in and accepts", async ({ page }) => {
  const live = await isLiveBuild(page);
  test.skip(!live, "This build has no connection settings, so it runs as sample data.");

  const owner = credentials("OWNER");
  const invitee = credentials("INVITEE");
  test.skip(!owner || !invitee, "No owner/invitee test accounts configured for this environment.");

  await signIn(page, owner!);
  await page.goto("/dashboard/team", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();

  // Clean slate: if a previous run left the invitee as a member, remove them
  // first so create_company_invitation() doesn't reject a duplicate invite.
  const existingRow = page.getByRole("row", { name: new RegExp(invitee!.email) });
  if (await existingRow.count()) {
    page.once("dialog", (dialog) => void dialog.accept());
    await existingRow.getByRole("button", { name: "Remove" }).click();
    await expect(existingRow).not.toBeVisible();
  }

  await page.getByLabel("Email").fill(invitee!.email);
  await page.getByLabel("Role").selectOptions("project_engineer");
  await page.getByRole("button", { name: "Send invitation" }).click();

  const linkLocator = page.getByRole("link", { name: /\/accept-invite\// });
  await expect(linkLocator).toBeVisible();
  const acceptUrl = await linkLocator.getAttribute("href");
  expect(acceptUrl).toBeTruthy();

  const acceptPath = new URL(acceptUrl!).pathname;

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, invitee!);
  await page.goto(acceptPath, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByRole("button", { name: "Go to your dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Go to your dashboard" }).click();

  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, owner!);
  await page.goto("/dashboard/team", { waitUntil: "domcontentloaded" });

  const newRow = page.getByRole("row", { name: new RegExp(invitee!.email) });
  await expect(newRow).toBeVisible();

  // Clean up so the next run starts from the same state.
  page.once("dialog", (dialog) => void dialog.accept());
  await newRow.getByRole("button", { name: "Remove" }).click();
  await expect(newRow).not.toBeVisible();
});
```

- [ ] **Step 3: Confirm the spec is syntactically valid and skips cleanly with no credentials set**

```bash
bunx playwright test e2e/team-invite.spec.ts --list
```

Expected: lists the one test with no errors. Running it for real (`bun run e2e`) will skip it unless `E2E_OWNER_*`/`E2E_INVITEE_*`/`PLAYWRIGHT_BASE_URL` (or a built worker) are configured — that's expected locally and is reported separately, per the note in Task 12.

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers.ts e2e/team-invite.spec.ts
git commit -m "$(cat <<'EOF'
test: add E2E coverage for the invite-and-accept journey

Owner opens Team, invites a teammate, the teammate opens the accept
link, signs in, accepts, and appears in the member list - end to end,
against a real backend. Credential-gated like the rest of e2e/
role-flows.spec.ts; skips itself without E2E_OWNER_*/E2E_INVITEE_*
rather than weakening the access gate.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Final verification

Run the full checklist in order. Fix anything that fails before moving to the next command — do not skip ahead on a red result.

- [ ] **Step 1: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 2: Lint**

```bash
bun run lint
```

- [ ] **Step 3: Format check**

```bash
bun run format:check
```

If this fails only on files this plan touched, run `bun run format` and re-stage; do not reformat unrelated files in the same commit.

- [ ] **Step 4: Unit/component tests**

```bash
bun run test
```

- [ ] **Step 5: Database tests**

```bash
bun run db:verify
```

This exercises `supabase/tests/company-invitations.test.ts`, which already covers create/resend/revoke/accept, non-owner denial, cross-tenant RLS, expired/revoked rejection, and the last-owner guard — nothing in this plan touches the database, so this run is a regression check, not new coverage.

- [ ] **Step 6: Production build**

```bash
bun run build
```

Confirms `src/routeTree.gen.ts` is current and the app still builds for Cloudflare Workers.

- [ ] **Step 7: Browser E2E suite**

```bash
bun run e2e
```

Expected: the existing specs pass; `e2e/team-invite.spec.ts` and the credential-gated specs in `role-flows.spec.ts` skip unless `E2E_*` credentials and a live build/backend are configured for the environment under test.

- [ ] **Step 8: Report external setup separately**

In the final summary to the user, call out (do not fold into "done"):
- `E2E_OWNER_EMAIL`/`E2E_OWNER_PASSWORD` and `E2E_INVITEE_EMAIL`/`E2E_INVITEE_PASSWORD` need provisioning on whichever environment should run `e2e/team-invite.spec.ts` for real (same category as the already-provisioned `DEMO`/`MEMBER`/`STAFF` accounts).
- Real invitation email delivery depends on `RESEND_API_KEY` being configured for that environment (per `src/workflows/emailSender.ts`); without it, invitations are still created and the UI now always shows the accept link directly to the inviting owner, but no email is actually sent. This is pre-existing, unchanged by this plan.
- `VITE_APP_URL` must be set to the real deployed origin for that environment so emailed/shown accept links don't fall back to `http://localhost:3000` (see `docs/operations/environment-matrix.md`).

- [ ] **Step 9: Final commit if any fixes were needed**

If Steps 1-7 required any fixes not already committed in earlier tasks:

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: address final verification findings for teammate invitations

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

If nothing needed fixing, skip this step — there is nothing to commit.
