import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "@/features/legal/LegalPages";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Notice — VendorClr" },
      {
        name: "description",
        content: "VendorClr Privacy Notice (draft, pending legal/product approval).",
      },
    ],
  }),
  component: PrivacyPage,
});
