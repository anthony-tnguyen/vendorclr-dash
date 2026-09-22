import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "@/features/legal/LegalPages";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — VendorClr" },
      {
        name: "description",
        content: "VendorClr Terms of Service (draft, pending legal/product approval).",
      },
    ],
  }),
  component: TermsPage,
});
