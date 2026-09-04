import { createFileRoute } from "@tanstack/react-router";
import { VendorDetailPage } from "@/features/vendors/VendorDetailPage";

export const Route = createFileRoute("/dashboard/vendors/$vendorId")({
  head: () => ({
    meta: [
      { title: "Vendor detail — VendorClr" },
      {
        name: "description",
        content: "Vendor compliance record: rail status, coverage limits, policy and contacts.",
      },
      { property: "og:title", content: "Vendor detail — VendorClr" },
      { property: "og:description", content: "Vendor compliance record and coverage limits." },
    ],
  }),
  component: VendorDetailRoute,
});

function VendorDetailRoute() {
  const { vendorId } = Route.useParams();
  return <VendorDetailPage vendorId={vendorId} />;
}
