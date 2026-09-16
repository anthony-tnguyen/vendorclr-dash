import { createFileRoute } from "@tanstack/react-router";
import { OperationsPage } from "@/features/admin/OperationsPage";

export const Route = createFileRoute("/dashboard/admin/operations")({
  head: () => ({
    meta: [
      { title: "Operations — VendorClr admin" },
      {
        name: "description",
        content: "Failed jobs, stale reviews, delivery problems and scheduled-job health.",
      },
      { property: "og:title", content: "Operations — VendorClr admin" },
      {
        property: "og:description",
        content: "Internal observability for extraction, review and delivery pipelines.",
      },
    ],
  }),
  component: OperationsPage,
});
