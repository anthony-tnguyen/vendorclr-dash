import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The console gate.
 *
 * Signed-out visitors belong on the sign-in screen, not on an empty console -
 * but only when a backend is actually configured. With no backend the app is
 * the browsable sample-data demo, and a sign-in form that cannot sign anyone in
 * would be a dead end, so nothing is gated.
 */

const authStub = {
  getSession: vi.fn(async () => ({ data: { session: null } })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  signOut: vi.fn(async () => ({ error: null })),
};

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({
    auth: authStub,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        order: () => ({
          limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      }),
    }),
    rpc: async () => ({ data: false, error: null }),
  }),
}));

async function renderRoute(initialEntry: string) {
  const { getRouter } = await import("@/router");
  const router = getRouter();
  router.update({
    ...router.options,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("signed-out console gate", () => {
  it("sends a signed-out visitor from the dashboard to the sign-in screen", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key-for-tests");

    const router = await renderRoute("/dashboard/vendors");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(router.state.location.search).toMatchObject({ redirect: "/dashboard/vendors" });
  });

  it("leaves the sample-data dashboard open when no backend is configured", async () => {
    await renderRoute("/dashboard");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Compliance overview" }),
    ).toBeInTheDocument();
  });

  it("routes the site entry point to the dashboard in sample-data mode", async () => {
    const router = await renderRoute("/");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/dashboard");
    });
  });
});
