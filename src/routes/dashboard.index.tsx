import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/features/overview/OverviewPage";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Program overview — VendorClear" },
      {
        name: "description",
        content:
          "Compliance posture across construction projects: COI, endorsements, lien waivers and renewals.",
      },
      { property: "og:title", content: "Program overview — VendorClear" },
      {
        property: "og:description",
        content: "Compliance posture across active construction projects.",
      },
    ],
  }),
  component: OverviewPage,
});
