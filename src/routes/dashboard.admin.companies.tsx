import { createFileRoute } from "@tanstack/react-router";
import { CompaniesPage } from "@/features/admin/CompaniesPage";

export const Route = createFileRoute("/dashboard/admin/companies")({
  head: () => ({
    meta: [
      { title: "Companies — VendorClear admin" },
      { name: "description", content: "Customer accounts, plans and vendor counts." },
      { property: "og:title", content: "Companies — VendorClear admin" },
      { property: "og:description", content: "Customer accounts and plan coverage." },
    ],
  }),
  component: CompaniesPage,
});
