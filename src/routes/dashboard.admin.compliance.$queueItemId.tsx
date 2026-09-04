import { createFileRoute } from "@tanstack/react-router";
import { DocumentReviewPage } from "@/features/admin/DocumentReviewPage";

export const Route = createFileRoute("/dashboard/admin/compliance/$queueItemId")({
  head: () => ({
    meta: [
      { title: "Review document — VendorClr admin" },
      {
        name: "description",
        content:
          "Compare an extracted certificate against what's on file and approve or reject it.",
      },
      { property: "og:title", content: "Review document — VendorClr admin" },
      { property: "og:description", content: "Approve or reject a vendor document by hand." },
    ],
  }),
  component: DocumentReviewRoute,
});

function DocumentReviewRoute() {
  const { queueItemId } = Route.useParams();
  return <DocumentReviewPage queueItemId={queueItemId} />;
}
