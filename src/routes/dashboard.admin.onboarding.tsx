import { createFileRoute } from "@tanstack/react-router";
import { OnboardingReviewPage } from "@/features/admin/OnboardingReviewPage";

export const Route = createFileRoute("/dashboard/admin/onboarding")({
  head: () => ({
    meta: [
      { title: "Onboarding review — VendorClr admin" },
      {
        name: "description",
        content: "Validate a new company's setup and launch their managed-service workspace.",
      },
      { property: "og:title", content: "Onboarding review — VendorClr admin" },
      {
        property: "og:description",
        content: "Step 6 of onboarding: validate the setup, then set the workspace live.",
      },
    ],
  }),
  component: OnboardingReviewPage,
});
