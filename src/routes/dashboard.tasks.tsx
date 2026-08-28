import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "@/features/tasks/TasksPage";

export const Route = createFileRoute("/dashboard/tasks")({
  head: () => ({
    meta: [
      { title: "Tasks — VendorClear" },
      { name: "description", content: "Open compliance follow-ups owned by your risk team." },
      { property: "og:title", content: "Tasks — VendorClear" },
      { property: "og:description", content: "Open compliance follow-ups by owner and due date." },
    ],
  }),
  component: TasksPage,
});
