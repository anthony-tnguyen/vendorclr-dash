import { createFileRoute } from "@tanstack/react-router";
import { ProjectsPage } from "@/features/projects/ProjectsPage";

export const Route = createFileRoute("/dashboard/projects/")({
  head: () => ({ meta: [{ title: "Projects — VendorClr" }, { name: "description", content: "Manage project vendors and insurance requirements." }] }),
  component: ProjectsPage,
});
