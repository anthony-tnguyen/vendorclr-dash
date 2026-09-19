import { createFileRoute } from "@tanstack/react-router";
import { TeamPage } from "@/features/team/TeamPage";

export const Route = createFileRoute("/dashboard/team")({
  head: () => ({
    meta: [
      { title: "Team — VendorClr" },
      {
        name: "description",
        content: "Who has access to your workspace and what each person can do.",
      },
      { property: "og:title", content: "Team — VendorClr" },
      { property: "og:description", content: "Manage teammate roles and access." },
    ],
  }),
  component: TeamPage,
});
