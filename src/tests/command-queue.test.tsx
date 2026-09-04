import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { getRouter } from "@/router";

async function renderRoute(initialEntry: string) {
  const router = getRouter();
  router.update({
    ...router.options,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return userEvent.setup();
}

describe("command-queue dashboards", () => {
  it("keeps the customer focused on a selected compliance exception and its resolution evidence", async () => {
    const user = await renderRoute("/dashboard");

    expect(await screen.findByRole("heading", { name: "Needs action now" })).toBeInTheDocument();
    expect((await screen.findAllByText("Delgado Concrete Works")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("link", { name: "Delgado Concrete Works" })).toHaveAttribute(
      "href",
      "/dashboard/vendors/vnd-1177",
    );
    expect(screen.getByRole("heading", { name: "Resolution inspector" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inspect Rivera Electrical Contractors" }));

    expect(
      within(screen.getByRole("complementary", { name: "Resolution inspector" })).getByText(
        "Rivera Electrical Contractors",
      ),
    ).toBeInTheDocument();
  });

  it("shows only role-appropriate navigation for the customer command center", async () => {
    await renderRoute("/dashboard");

    const navigation = screen.getByRole("navigation", { name: "Dashboard sections" });
    expect(within(navigation).getByText("Command center")).toBeInTheDocument();
    expect(within(navigation).queryByText("Review queue")).not.toBeInTheDocument();
  });

  it("gives administrators a review queue with the highest-priority item already selected", async () => {
    const user = await renderRoute("/dashboard/admin");
    await user.click(screen.getByRole("button", { name: /preview as administrator/i }));

    expect(
      await screen.findByRole("heading", { name: "Queue requiring review" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Inspect Certificate of insurance from Delgado Concrete Works",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Review inspector" })).toHaveTextContent(
      "Certificate of insurance",
    );
  });
});
