import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useSession } from "@/app/App";
import { LoadingState } from "@/components/states/AsyncState";

/**
 * Entry point.
 *
 * Signed-out visitors get the sign-in screen; everyone else goes to the console.
 * The decision cannot live in beforeLoad: the session lives in React context
 * (src/app/App.tsx), not router context, and is resolved asynchronously.
 *
 * In demo mode `status` is always "authenticated", so the preview keeps landing
 * on /dashboard exactly as before.
 */
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VendorClr — Workspace access" },
      { name: "description", content: "Sign in to your VendorClr vendor compliance workspace." },
      { property: "og:title", content: "VendorClr — Workspace access" },
      {
        property: "og:description",
        content: "Sign in to your VendorClr vendor compliance workspace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LandingRedirect,
});

function LandingRedirect() {
  const { status } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (status === "loading") return;
    void navigate({ to: status === "anonymous" ? "/login" : "/dashboard", replace: true });
  }, [status, navigate]);

  return (
    <div className="min-h-screen bg-background px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <LoadingState label="Loading VendorClr" rows={3} />
      </div>
    </div>
  );
}
