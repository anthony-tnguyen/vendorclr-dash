import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — VendorClear" },
      {
        name: "description",
        content: "Demo sign-in screen for the VendorClear construction vendor compliance console.",
      },
      { property: "og:title", content: "Sign in — VendorClear" },
      { property: "og:description", content: "Demo sign-in for VendorClear compliance operations." },
    ],
  }),
  component: LoginPage,
});
