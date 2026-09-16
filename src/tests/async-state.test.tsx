import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeniedState, ErrorState } from "@/components/states/AsyncState";

describe("actionable state accessibility", () => {
  it.each([
    ["load failure", <ErrorState description="The roster could not load." />],
    ["permission denial", <DeniedState description="You cannot view this queue." />],
  ])("moves focus to the %s alert when it replaces route content", (_state, element) => {
    render(element);

    const alert = screen.getByRole("alert");

    expect(alert).toHaveFocus();
  });
});
