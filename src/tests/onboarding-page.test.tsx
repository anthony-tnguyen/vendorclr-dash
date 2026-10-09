import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRepository } from "@/data/repository";

/**
 * OnboardingPage through the real router, in sample-data (demo) mode — no backend
 * configured, so the in-memory demo repository backs the wizard and no Supabase
 * client is needed. Covers the optionality copy, the "Skip for now" affordance,
 * the review summary and sign-out routing (the Phase 1-3 behaviours).
 */

async function renderOnboarding(initialEntry = "/onboarding") {
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

beforeEach(() => {
  // Force sample-data (demo) mode regardless of ambient env, and start each test
  // from a fresh in-memory onboarding state.
  vi.stubEnv("VITE_SUPABASE_URL", "");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
  resetRepository();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  resetRepository();
});

describe("onboarding wizard (demo mode)", () => {
  it("shows the optionality copy and requires only the company name on step 1", async () => {
    await renderOnboarding();
    expect(await screen.findByText(/Only your company name is required/i)).toBeInTheDocument();
    // The company-name field carries the required marker.
    const company = screen.getByLabelText(/Company name/i);
    expect(company).toBeRequired();
  });

  it("offers Skip for now on an empty optional step and advances", async () => {
    const user = userEvent.setup();
    await renderOnboarding();

    // Wait for the onboarding query to resolve (the page shows a loading state
    // first) before the field exists.
    await user.type(await screen.findByLabelText(/Company name/i), "Halstead Builders");
    await user.click(screen.getByRole("button", { name: /Save & continue/i }));

    // Step 2 (Compliance program) is optional and empty -> Skip for now shows.
    expect(await screen.findByText("Compliance program")).toBeInTheDocument();
    expect(await screen.findByText(/Optional — skip anything now/i)).toBeInTheDocument();
    const skip = screen.getByRole("button", { name: /Skip for now/i });
    await user.click(skip);

    // Advanced to step 3 (Projects).
    expect(await screen.findByText("Projects")).toBeInTheDocument();
  });

  it("reassures a buyer returning from successful checkout", async () => {
    await renderOnboarding("/onboarding?checkout=success");

    expect(await screen.findByText(/Payment confirmed/i)).toBeInTheDocument();
    expect(screen.getByText(/VendorClr will take it from here/i)).toBeInTheDocument();
  });

  it("signs out to the login screen", async () => {
    const user = userEvent.setup();
    const router = await renderOnboarding();

    await user.click(screen.getByRole("button", { name: /Sign out/i }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
  });
});
