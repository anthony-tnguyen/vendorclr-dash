import { createFileRoute } from "@tanstack/react-router";
import { HelpPage } from "@/features/help/HelpPage";

export const Route = createFileRoute("/dashboard/help")({
  head: () => ({
    meta: [
      { title: "Help & FAQ — VendorClr" },
      {
        name: "description",
        content: "Answers on vendor uploads, compliance status, renewal reminders and access.",
      },
      { property: "og:title", content: "Help & FAQ — VendorClr" },
      {
        property: "og:description",
        content: "Answers on vendor uploads, compliance status, renewal reminders and access.",
      },
    ],
  }),
  component: HelpPage,
});
