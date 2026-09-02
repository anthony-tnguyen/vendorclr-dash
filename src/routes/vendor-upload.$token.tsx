import { createFileRoute } from "@tanstack/react-router";
import { VendorUploadPortal } from "@/features/vendor-upload/VendorUploadPortal";

/**
 * Public route. No AppShell, no auth guard, no demo-role switcher - this is the
 * page an external vendor lands on from the magic link in their email, and they
 * never get a VendorClear account or a dashboard session.
 */
export const Route = createFileRoute("/vendor-upload/$token")({
  head: () => ({
    meta: [
      { title: "Upload your certificate of insurance — VendorClear" },
      {
        name: "description",
        content: "Upload a renewed certificate of insurance for your client.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: VendorUploadRoute,
});

function VendorUploadRoute() {
  const { token } = Route.useParams();
  return <VendorUploadPortal token={token} />;
}
