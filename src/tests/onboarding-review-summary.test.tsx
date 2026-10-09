import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OnboardingReviewSummary } from "@/features/onboarding/OnboardingReviewSummary";

describe("OnboardingReviewSummary", () => {
  it("treats blank optional answers as optional instead of unfinished work", () => {
    render(
      <OnboardingReviewSummary
        sections={{
          companyInfo: { companyName: "Halstead Builders" },
          program: {},
          projects: {},
          requirements: {},
        }}
        onEditStep={vi.fn()}
      />,
    );

    expect(screen.getByText("Halstead Builders")).toBeInTheDocument();
    expect(screen.getByText(/Optional details can be added later/i)).toBeInTheDocument();
    expect(screen.queryByText(/unanswered/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Not provided")).not.toBeInTheDocument();
  });
});
