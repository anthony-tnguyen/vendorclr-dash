import { createFileRoute } from "@tanstack/react-router";
import { InvitesPage } from "@/features/admin/InvitesPage";

export const Route = createFileRoute("/dashboard/admin/invites")({
  head: () => ({
    meta: [
      { title: "Signup invites — VendorClr admin" },
      { name: "description", content: "Admin-issued codes that gate business signup." },
      { property: "og:title", content: "Signup invites — VendorClr admin" },
      { property: "og:description", content: "Codes that gate business signup." },
    ],
  }),
  component: InvitesPage,
});
