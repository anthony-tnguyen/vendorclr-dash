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
