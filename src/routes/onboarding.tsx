import { createFileRoute } from "@tanstack/react-router";

import { OnboardingPage } from "@/features/onboarding/OnboardingPage";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Onboarding — VendorClr" },
      {
        name: "description",
        content: "Set up your VendorClr workspace after checkout.",
      },
    ],
  }),
  component: OnboardingPage,
});
