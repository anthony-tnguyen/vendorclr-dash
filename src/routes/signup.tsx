import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Create account — VendorClr" },
      {
        name: "description",
        content: "Demo account creation for VendorClr subcontractor compliance tracking.",
      },
      { property: "og:title", content: "Create account — VendorClr" },
      {
        property: "og:description",
        content: "Demo account creation for VendorClr compliance tracking.",
      },
    ],
  }),
  component: SignupPage,
});
