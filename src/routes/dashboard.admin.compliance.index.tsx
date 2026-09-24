import { createFileRoute } from "@tanstack/react-router";
import { ComplianceQueuePage } from "@/features/admin/ComplianceQueuePage";

export const Route = createFileRoute("/dashboard/admin/compliance/")({
  head: () => ({
    meta: [
      { title: "Compliance queue — VendorClr admin" },
      { name: "description", content: "Vendor documents awaiting reviewer action." },
      { property: "og:title", content: "Compliance queue — VendorClr admin" },
      { property: "og:description", content: "Vendor documents awaiting review." },
    ],
  }),
  component: ComplianceQueuePage,
});
