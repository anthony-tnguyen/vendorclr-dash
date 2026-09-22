import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/signup")({
  // Same same-origin-only guard as /login's redirect (see src/routes/login.tsx),
  // reused so a signup started from a flow like accept-invite can land back
  // where it began instead of always landing on /demo.
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const raw = search["redirect"];
    return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
      ? { redirect: raw }
      : {};
  },
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
