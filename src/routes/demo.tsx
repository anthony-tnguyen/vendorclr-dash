import { createFileRoute } from "@tanstack/react-router";
import { DemoScreen } from "@/features/demo/DemoScreen";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "Demo console — VendorClr" },
      {
        name: "description",
        content:
          "Look around the VendorClr vendor compliance console with sample data before your workspace is activated.",
      },
      { property: "og:title", content: "Demo console — VendorClr" },
      {
        property: "og:description",
        content:
          "A read-only tour of the VendorClr compliance rail, vendor roster and requirement checks, using sample construction data.",
      },
      { property: "og:type", content: "website" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DemoScreen,
});
