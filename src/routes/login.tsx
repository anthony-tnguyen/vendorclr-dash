import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/login")({
  /**
   * Where to land after a successful sign-in. Only same-origin relative paths
   * are accepted - anything else (an absolute URL, a protocol-relative "//host")
   * would turn the sign-in screen into an open redirect.
   */
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const raw = search["redirect"];
    return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
      ? { redirect: raw }
      : {};
  },
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
