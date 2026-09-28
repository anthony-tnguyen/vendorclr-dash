import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/features/overview/OverviewPage";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Compliance overview — VendorClr" },
      {
        name: "description",
        content:
          "Compliance posture across construction projects: COI, endorsements, lien waivers and renewals.",
      },
      { property: "og:title", content: "Compliance overview — VendorClr" },
      {
        property: "og:description",
        content: "Compliance posture across active construction projects.",
      },
    ],
  }),
  component: OverviewPage,
});
