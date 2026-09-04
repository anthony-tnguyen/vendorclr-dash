import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — VendorClr" },
      {
        name: "description",
        content: "Demo sign-in screen for the VendorClr construction vendor compliance console.",
      },
      { property: "og:title", content: "Sign in — VendorClr" },
      {
        property: "og:description",
        content: "Demo sign-in for VendorClr compliance operations.",
      },
    ],
  }),
  component: LoginPage,
});
