import { createFileRoute } from "@tanstack/react-router";
import { ReportsPage } from "@/features/reports/ReportsPage";

export const Route = createFileRoute("/dashboard/reports")({
  head: () => ({
    meta: [
      { title: "Reports — VendorClr" },
      { name: "description", content: "Project level compliance rollup for the current period." },
      { property: "og:title", content: "Reports — VendorClr" },
      { property: "og:description", content: "Project level compliance rollup." },
    ],
  }),
  component: ReportsPage,
});
