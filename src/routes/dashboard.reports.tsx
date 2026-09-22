import { createFileRoute } from "@tanstack/react-router";
import { ReportsPage } from "@/features/reports/ReportsPage";
import { isReportKind, type ReportKind } from "@/workflows/reportCatalog";

export const Route = createFileRoute("/dashboard/reports")({
  validateSearch: (search: Record<string, unknown>): { report?: ReportKind } =>
    isReportKind(search["report"]) ? { report: search["report"] } : {},
  head: () => ({
    meta: [
      { title: "Reports — VendorClr" },
      { name: "description", content: "Assignment-based compliance reporting and CSV export." },
      { property: "og:title", content: "Reports — VendorClr" },
      { property: "og:description", content: "Assignment-based compliance reporting." },
    ],
  }),
  component: ReportsRoute,
});

function ReportsRoute() {
  const { report } = Route.useSearch();
  return <ReportsPage report={report} />;
}
