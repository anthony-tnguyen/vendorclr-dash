import { createFileRoute } from "@tanstack/react-router";

import { CheckoutPage } from "@/features/checkout/CheckoutPage";

export const Route = createFileRoute("/checkout")({
  validateSearch: (search: Record<string, unknown>): { plan?: string; canceled?: string } => {
    const planRaw = search["plan"];
    const plan =
      typeof planRaw === "string" && ["core", "operations", "scale"].includes(planRaw)
        ? planRaw
        : undefined;
    const canceled = search["canceled"] ? "1" : undefined;
    return { ...(plan ? { plan } : {}), ...(canceled ? { canceled } : {}) };
  },
  head: () => ({
    meta: [
      { title: "Choose your plan — VendorClr" },
      { name: "description", content: "Select a VendorClr plan and check out." },
    ],
  }),
  component: CheckoutPage,
});
