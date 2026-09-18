import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { getRouter } from "@/router";
import {
  REQUIREMENT_CATALOG,
  canEditRequirements,
  validateRequirementSettings,
  type RequirementSettingValue,
} from "@/data/repositories/requirementSettings";

function values(overrides: Record<string, RequirementSettingValue>) {
  const base: Record<string, RequirementSettingValue> = {};
  for (const spec of REQUIREMENT_CATALOG) base[spec.key] = { enabled: false, amount: null };
  return { ...base, ...overrides };
}

describe("requirement settings", () => {
  it("only lets owners and risk managers edit", () => {
    expect(canEditRequirements("owner")).toBe(true);
    expect(canEditRequirements("risk_manager")).toBe(true);
    expect(canEditRequirements("project_engineer")).toBe(false);
    expect(canEditRequirements("read_only")).toBe(false);
    expect(canEditRequirements(null)).toBe(false);
  });

  it("requires a positive whole amount on an enabled limit rule", () => {
    const key = "general_liability_each_occurrence_limit";
    expect(
      validateRequirementSettings(values({ [key]: { enabled: true, amount: null } }))[key],
    ).toBeTruthy();
    expect(
      validateRequirementSettings(values({ [key]: { enabled: true, amount: 0 } }))[key],
    ).toBeTruthy();
    expect(
      validateRequirementSettings(values({ [key]: { enabled: true, amount: 1.5 } }))[key],
    ).toBeTruthy();
    expect(
      validateRequirementSettings(values({ [key]: { enabled: true, amount: 2000000 } }))[key],
    ).toBeUndefined();
  });

  it("ignores amounts on requirements that are switched off", () => {
    const key = "general_liability_each_occurrence_limit";
    expect(
      validateRequirementSettings(values({ [key]: { enabled: false, amount: null } })),
    ).toEqual({});
  });

  it("uses the compliance engine's configuration vocabulary", () => {
    const gl = REQUIREMENT_CATALOG.find((s) => s.key === "general_liability_each_occurrence_limit");
    expect(gl?.configuration).toEqual({ limitField: "each_occurrence_limit" });
    const ai = REQUIREMENT_CATALOG.find((s) => s.key === "general_liability_additional_insured");
    expect(ai?.configuration).toEqual({ endorsementField: "additional_insured" });
    const coi = REQUIREMENT_CATALOG.find((s) => s.key === "document_certificate_of_insurance");
    expect(coi?.configuration).toEqual({ documentKind: "certificate_of_insurance" });
  });

  it("renders the editable requirement form and never claims a demo save persisted", async () => {
    const router = getRouter();
    router.update({
      ...router.options,
      history: createMemoryHistory({ initialEntries: ["/dashboard/settings"] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);

    expect(await screen.findByText("Coverage types and minimum limits")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Primary and non-contributory"));
    fireEvent.click(screen.getByRole("button", { name: "Save requirements" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/not saved to any database/i);
  });
});
