import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getRouter } from "@/router";

const expectedRouteIds = [
  "/login",
  "/signup",
  "/reset-password",
  "/dashboard/",
  "/dashboard/vendors/",
  "/dashboard/vendors/$vendorId",
  "/dashboard/tasks",
  "/dashboard/reports",
  "/dashboard/settings",
  "/dashboard/help",
  "/dashboard/admin/",
  "/dashboard/admin/companies",
  "/dashboard/admin/compliance",
  "/dashboard/admin/leads",
  "/dashboard/admin/access",
  "/dashboard/admin/invites",
] as const;

function createTestRouter(initialEntry: string) {
  const router = getRouter();
  router.update({
    // Spread the existing options: update() replaces the whole option set, and
    // getRouter() supplies routeTree and the queryClient context that the root
    // route requires. Passing history alone drops them.
    ...router.options,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return router;
}

/*
 * src/test/setup.ts calls Testing Library cleanup after every test. That
 * unmounts RouterProvider and releases its subscriptions; this TanStack Router
 * version exposes no router.dispose() lifecycle API.
 */
describe("generated TanStack route tree", () => {
  it("registers every required customer and administrator route", () => {
    const router = createTestRouter("/dashboard");
    const registeredRouteIds = Object.keys(router.routesById);

    expect(registeredRouteIds).toEqual(expect.arrayContaining([...expectedRouteIds]));
  });

  it("matches the dynamic vendor route and supplies the real vendorId parameter", async () => {
    const router = createTestRouter("/dashboard/vendors/vnd-1042");

    await router.load();
    const detailMatch = router.state.matches.find(
      (match) => match.routeId === "/dashboard/vendors/$vendorId",
    );

    expect(detailMatch?.params).toMatchObject({ vendorId: "vnd-1042" });

    render(<RouterProvider router={router} />);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Corbett Structural Steel" }),
    ).toBeInTheDocument();
  });

  it("navigates through the actual router to a vendor detail URL", async () => {
    const router = createTestRouter("/dashboard/vendors");

    await router.load();
    render(<RouterProvider router={router} />);

    await router.navigate({
      to: "/dashboard/vendors/$vendorId",
      params: { vendorId: "vnd-1177" },
    });

    expect(router.state.location.pathname).toBe("/dashboard/vendors/vnd-1177");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Delgado Concrete Works" }),
    ).toBeInTheDocument();
  });
});
