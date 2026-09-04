import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset password — VendorClr" },
      { name: "description", content: "Demo password reset screen for VendorClr." },
      { property: "og:title", content: "Reset password — VendorClr" },
      { property: "og:description", content: "Demo password reset screen for VendorClr." },
    ],
  }),
  component: ResetPasswordPage,
});
