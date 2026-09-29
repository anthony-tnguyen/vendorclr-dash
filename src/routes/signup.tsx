import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "@/features/auth/AuthPages";

export const Route = createFileRoute("/signup")({
  // Same same-origin-only guard as /login's redirect (see src/routes/login.tsx),
  // reused so a signup started from a flow like accept-invite can land back
  // where it began instead of always landing on /demo.
  validateSearch: (search: Record<string, unknown>): { redirect?: string; plan?: string } => {
    const raw = search["redirect"];
    const redirect =
      typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : undefined;
    // Plan chosen on the marketing site (/signup?plan=core). Validated against the
    // self-checkout set so a signed-up account can be sent straight to checkout.
    const planRaw = search["plan"];
    const plan =
      typeof planRaw === "string" && ["core", "operations", "scale"].includes(planRaw)
        ? planRaw
        : undefined;
    return { ...(redirect ? { redirect } : {}), ...(plan ? { plan } : {}) };
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
