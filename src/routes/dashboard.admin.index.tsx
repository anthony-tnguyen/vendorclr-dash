import { createFileRoute } from "@tanstack/react-router";
import { AdminOverviewPage } from "@/features/admin/AdminOverviewPage";

export const Route = createFileRoute("/dashboard/admin/")({
  head: () => ({
    meta: [
      { title: "Administrator overview — VendorClr" },
      { name: "description", content: "Platform operations summary across customer accounts." },
      { property: "og:title", content: "Administrator overview — VendorClr" },
      { property: "og:description", content: "Platform operations summary." },
    ],
  }),
  component: AdminOverviewPage,
});
