import { createFileRoute } from "@tanstack/react-router";
import { AccessPage } from "@/features/admin/AccessPage";

export const Route = createFileRoute("/dashboard/admin/access")({
  head: () => ({
    meta: [
      { title: "Access management — VendorClr admin" },
      { name: "description", content: "Roles and project scopes for platform users." },
      { property: "og:title", content: "Access management — VendorClr admin" },
      { property: "og:description", content: "Roles and project scopes." },
    ],
  }),
  component: AccessPage,
});
