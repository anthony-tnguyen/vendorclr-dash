import { createFileRoute } from "@tanstack/react-router";
import { AcceptInvitePage } from "@/features/team/AcceptInvitePage";

/**
 * Public route: the link a teammate receives by email. No AppShell, no auth
 * guard - AcceptInvitePage itself decides what an unauthenticated, wrongly
 * authenticated, or correctly authenticated visitor sees.
 */
export const Route = createFileRoute("/accept-invite/$token")({
  head: () => ({
    meta: [
      { title: "Accept invitation — VendorClr" },
      { name: "description", content: "Accept an invitation to join a company on VendorClr." },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AcceptInviteRoute,
});

function AcceptInviteRoute() {
  const { token } = Route.useParams();
  return <AcceptInvitePage token={token} />;
}
