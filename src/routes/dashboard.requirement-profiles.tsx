import { createFileRoute } from "@tanstack/react-router";
import { RequirementProfilesPage } from "@/features/requirement-profiles/RequirementProfilesPage";

export const Route = createFileRoute("/dashboard/requirement-profiles")({
  head: () => ({ meta: [{ title: "Requirement profiles — VendorClr" }] }),
  component: RequirementProfilesPage,
});
