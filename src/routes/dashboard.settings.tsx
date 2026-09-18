import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/features/settings/SettingsPage";

export const Route = createFileRoute("/dashboard/settings")({
  head: () => ({
    meta: [
      { title: "Insurance requirements — VendorClr" },
      {
        name: "description",
        content: "Coverage minimums, endorsements and documents every vendor must satisfy.",
      },
      { property: "og:title", content: "Insurance requirements — VendorClr" },
      {
        property: "og:description",
        content: "Configure the coverage, endorsements and documents your vendors must provide.",
      },
    ],
  }),
  component: SettingsPage,
});
