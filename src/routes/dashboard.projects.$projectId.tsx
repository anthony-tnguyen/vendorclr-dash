import { createFileRoute } from "@tanstack/react-router";
import { ProjectDetailPage } from "@/features/projects/ProjectDetailPage";

export const Route = createFileRoute("/dashboard/projects/$projectId")({
  head: () => ({ meta: [{ title: "Project detail — VendorClr" }] }),
  component: ProjectDetailRoute,
});

function ProjectDetailRoute() {
  const { projectId } = Route.useParams();
  return <ProjectDetailPage projectId={projectId} />;
}
