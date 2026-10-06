import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { getRepository, resetRepository } from "@/data/repository";
import { VendorForm } from "@/features/vendors/VendorForm";

/**
 * VendorForm renders against the in-memory demo repository (no backend env),
 * so this proves the add-vendor path end to end at the component level: the
 * trade <select> offers "Other", and choosing it saves a vendor whose trade is
 * the literal string "Other".
 */

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  resetRepository();
});

describe("VendorForm", () => {
  it("offers 'Other' as the last trade option", () => {
    render(wrap(<VendorForm />));
    const options = Array.from(
      (screen.getByLabelText("Trade") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toContain("Other");
    expect(options[options.length - 1]).toBe("Other");
  });

  it("adds a vendor with trade 'Other' and saves it as the literal string", async () => {
    const user = userEvent.setup();
    render(wrap(<VendorForm />));

    await user.type(screen.getByLabelText("Vendor name"), "Miscellany Subs");
    await user.selectOptions(screen.getByLabelText("Trade"), "Other");
    await user.click(screen.getByRole("button", { name: /Add to demo roster/ }));

    await screen.findByRole("status");

    await waitFor(async () => {
      const roster = await getRepository().listVendors();
      expect(roster.find((v) => v.name === "Miscellany Subs")?.trade).toBe("Other");
    });
  });
});
