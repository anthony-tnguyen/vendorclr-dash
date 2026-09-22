import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Team page: role changes and removal go through the owner-only server
 * functions, and a non-owner sees the roster without any controls.
 */

const OWNER_ID = "u-owner";
const members = [
  {
    id: "m-owner",
    userId: OWNER_ID,
    email: "owner@acme.test",
    role: "owner",
    isActive: true,
    lastActiveAt: null,
    createdAt: "2026-09-01T00:00:00Z",
  },
  {
    id: "m-eng",
    userId: "u-eng",
    email: "eng@acme.test",
    role: "project_engineer",
    isActive: true,
    lastActiveAt: "2026-09-10T00:00:00Z",
    createdAt: "2026-09-02T00:00:00Z",
  },
];

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

let membership = { company_id: "c-1", role: "owner" };

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: OWNER_ID, email: "owner@acme.test" } } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: async () => ({ error: null }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({
              data:
                table === "company_members"
                  ? { ...membership, companies: { name: "Acme", activation_status: "activated" } }
                  : null,
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async () => ({ data: false, error: null }),
  }),
}));

async function renderTeam() {
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-for-tests");
  const { getRouter } = await import("@/router");
  const router = getRouter();
  router.update({
    ...router.options,
    history: createMemoryHistory({ initialEntries: ["/dashboard/team"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
  membership = { company_id: "c-1", role: "owner" };
});

describe("team page", () => {
  it("shows the sample-data message when no backend is configured", async () => {
    const { getRouter } = await import("@/router");
    const router = getRouter();
    router.update({
      ...router.options,
      history: createMemoryHistory({ initialEntries: ["/dashboard/team"] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);

    expect(await screen.findByText("No live workspace")).toBeInTheDocument();
  });

  it("lets an owner change a teammate's role", async () => {
    await renderTeam();
    const user = userEvent.setup();

    const select = await screen.findByRole("combobox", { name: "Role for eng@acme.test" });
    await user.selectOptions(select, "risk_manager");

    await waitFor(() => {
      expect(changeCompanyMemberRole).toHaveBeenCalledWith({
        data: { memberId: "m-eng", newRole: "risk_manager" },
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "eng@acme.test is now Risk manager",
    );
  });

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

  it("gives a non-owner the roster with no controls", async () => {
    membership = { company_id: "c-1", role: "read_only" };
    await renderTeam();

    expect(await screen.findByText("eng@acme.test")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Only an owner");
  });

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
});
