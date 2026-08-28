import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Create account — VendorClear" },
      {
        name: "description",
        content: "Demo account creation for VendorClear subcontractor compliance tracking.",
      },
      { property: "og:title", content: "Create account — VendorClear" },
      {
        property: "og:description",
        content: "Demo account creation for VendorClear compliance tracking.",
      },
    ],
  }),
  component: SignupPage,
});
