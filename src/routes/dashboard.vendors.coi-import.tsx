import { createFileRoute } from "@tanstack/react-router";

import { CoiImportPage } from "@/features/vendors/CoiImportPage";

export const Route = createFileRoute("/dashboard/vendors/coi-import")({
  head: () => ({
    meta: [
      { title: "Add vendors from COIs — VendorClr" },
      {
        name: "description",
        content:
          "Upload certificates of insurance and create vendors, policies and stored documents from them.",
      },
    ],
  }),
  component: CoiImportPage,
});
