import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/features/settings/SettingsPage";

export const Route = createFileRoute("/dashboard/settings")({
  head: () => ({
    meta: [
      { title: "Settings — VendorClr" },
      {
        name: "description",
        content: "Requirement defaults, coverage minimums and reminder contacts.",
      },
      { property: "og:title", content: "Settings — VendorClr" },
      { property: "og:description", content: "Requirement defaults and reminder contacts." },
    ],
  }),
  component: SettingsPage,
});
