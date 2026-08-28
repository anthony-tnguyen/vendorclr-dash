import { createFileRoute } from "@tanstack/react-router";
import { VendorsPage } from "@/features/vendors/VendorsPage";

export const Route = createFileRoute("/dashboard/vendors/")({
  head: () => ({
    meta: [
      { title: "Vendors — VendorClear" },
      {
        name: "description",
        content: "Subcontractor roster with a compact five-slot construction compliance rail.",
      },
      { property: "og:title", content: "Vendors — VendorClear" },
      { property: "og:description", content: "Subcontractor roster and compliance rail." },
    ],
  }),
  component: VendorsPage,
});
