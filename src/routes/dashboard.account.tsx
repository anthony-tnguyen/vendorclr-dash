import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "@/features/account/AccountPage";

export const Route = createFileRoute("/dashboard/account")({
  head: () => ({
    meta: [
      { title: "Account — VendorClr" },
      {
        name: "description",
        content: "Manage your profile name and change your sign-in password.",
      },
      { property: "og:title", content: "Account — VendorClr" },
      {
        property: "og:description",
        content: "Manage your profile name and change your sign-in password.",
      },
    ],
  }),
  component: AccountPage,
});
