import { createFileRoute } from "@tanstack/react-router";
import { VendorImportPage } from "@/features/vendors/VendorImportPage";

export const Route = createFileRoute("/dashboard/vendors/import")({
  head: () => ({
    meta: [
      { title: "Import vendors — VendorClr" },
      {
        name: "description",
        content: "Bulk CSV onboarding for projects, vendors and assignments.",
      },
    ],
  }),
  component: VendorImportPage,
});
