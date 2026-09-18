import { createFileRoute } from "@tanstack/react-router";
import { ActivationCodesPage } from "@/features/admin/ActivationCodesPage";

export const Route = createFileRoute("/dashboard/admin/activation")({
  head: () => ({
    meta: [
      { title: "Activation codes — VendorClr admin" },
      {
        name: "description",
        content: "Issue and withdraw the codes that open a paid VendorClr workspace.",
      },
      { property: "og:title", content: "Activation codes — VendorClr admin" },
      {
        property: "og:description",
        content: "One email, one use: codes that open a VendorClr workspace.",
      },
    ],
  }),
  component: ActivationCodesPage,
});
