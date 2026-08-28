import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset password — VendorClear" },
      { name: "description", content: "Demo password reset screen for VendorClear." },
      { property: "og:title", content: "Reset password — VendorClear" },
      { property: "og:description", content: "Demo password reset screen for VendorClear." },
    ],
  }),
  component: ResetPasswordPage,
});
