import { createFileRoute } from "@tanstack/react-router";
import { LeadsPage } from "@/features/admin/LeadsPage";

export const Route = createFileRoute("/dashboard/admin/leads")({
  head: () => ({
    meta: [
      { title: "Leads — VendorClr admin" },
      { name: "description", content: "Inbound pipeline from contractors and owners." },
      { property: "og:title", content: "Leads — VendorClr admin" },
      { property: "og:description", content: "Inbound pipeline by stage and source." },
    ],
  }),
  component: LeadsPage,
});
