import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — VendorClear" },
      {
        name: "description",
        content: "Sign in to the VendorClear construction vendor compliance console.",
      },
      { property: "og:title", content: "Sign in — VendorClear" },
      {
        property: "og:description",
        content: "Sign in for VendorClear compliance operations.",
      },
    ],
  }),
  component: LoginPage,
});
