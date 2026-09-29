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

    expect(
      await screen.findByRole("heading", { level: 1, name: "Compliance overview" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/vendors need resolution across \d+ active projects/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import vendors" })).toHaveAttribute(
      "href",
      "/dashboard/vendors/import",
    );
    expect(screen.getByRole("button", { name: /show action needed/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByRole("heading", { name: "Needs attention" })).toBeInTheDocument();
    expect((await screen.findAllByText("Delgado Concrete Works")).length).toBeGreaterThan(0);
    // The resolution inspector is a popup now: closed until a row is inspected.
    expect(screen.queryByRole("dialog", { name: "Resolution inspector" })).toBeNull();
    const register = screen.getByRole("table", { name: "Vendor compliance" });
    expect(within(register).getByRole("columnheader", { name: "Certificate of insurance" }));
    expect(within(register).getByRole("columnheader", { name: "Additional insured" }));
    expect(within(register).getByRole("columnheader", { name: "Waiver of subrogation" }));
    expect(within(register).getByRole("columnheader", { name: "Lien waiver" }));
    expect(within(register).getByRole("columnheader", { name: "Renewal" }));

    await user.click(screen.getByRole("button", { name: "Inspect Rivera Electrical Contractors" }));

    const inspector = screen.getByRole("dialog", { name: "Resolution inspector" });
    expect(within(inspector).getByText("Rivera Electrical Contractors")).toBeInTheDocument();

    // Closing the popup returns the customer to the queue.
    await user.click(screen.getByRole("button", { name: "Close resolution inspector" }));
    expect(screen.queryByRole("dialog", { name: "Resolution inspector" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /show expiring soon/i }));
    expect(screen.getByRole("button", { name: /show expiring soon/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Inspect Rivera Electrical Contractors" }));
    expect(screen.queryByRole("button", { name: "Inspect Delgado Concrete Works" })).toBeNull();
  });

  it("shows only role-appropriate navigation for the customer command center", async () => {
    await renderRoute("/dashboard");

    const navigation = screen.getByRole("navigation", { name: "Dashboard sections" });
    expect(within(navigation).getByText("Overview")).toBeInTheDocument();
    expect(within(navigation).queryByText("Review queue")).not.toBeInTheDocument();
  });

  it("gives administrators a review queue with the highest-priority item already selected", async () => {
    const user = await renderRoute("/dashboard/admin");
    await user.click(screen.getByRole("button", { name: /preview as administrator/i }));

    expect(
      await screen.findByRole("heading", { name: "Queue requiring review" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Review posture" })).toBeInTheDocument();
    expect(screen.getByLabelText("Escalated: 1, Needs reviewer attention")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Inspect Certificate of insurance from Delgado Concrete Works",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Review inspector" })).toHaveTextContent(
      "Certificate of insurance",
    );
    expect(
      screen.getByRole("button", {
        name: "Open review for Certificate of insurance from Delgado Concrete Works",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the mobile navigation out of the way until a user asks for it", async () => {
    const user = await renderRoute("/dashboard");

    expect(
      screen.queryByRole("navigation", { name: "Mobile dashboard sections" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open navigation menu" }));

    expect(screen.getByRole("navigation", { name: "Mobile dashboard sections" })).toHaveTextContent(
      "Overview",
    );
  });
});
