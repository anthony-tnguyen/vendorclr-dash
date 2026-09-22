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
