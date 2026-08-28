import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/AsyncState";
import { getRepository } from "@/data/repository";
import type { TaskItem } from "@/data/contracts";

const filters = ["all", "open", "waiting", "done"] as const;
type Filter = (typeof filters)[number];

const priorityStyles: Record<TaskItem["priority"], string> = {
  high: "border-destructive/30 bg-danger-soft text-destructive",
  medium: "border-warn/30 bg-warn-soft text-warn",
  low: "border-border bg-muted text-muted-foreground",
};

export function TasksPage() {
  const repo = getRepository();
  const [filter, setFilter] = useState<Filter>("all");
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => repo.listTasks() });

  const list = (tasks.data ?? []).filter((t) => filter === "all" || t.status === filter);

  return (
    <AppShell title="Tasks" subtitle="Compliance follow-ups owned by your team. Demo data only.">
      <div className="space-y-4">
        <fieldset>
          <legend className="text-sm font-medium text-foreground">Filter by status</legend>
          <div className="mt-2 flex flex-wrap gap-1">
            {filters.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                aria-label={`Show ${f} tasks`}
                className={`focusable rounded-sm border px-3 py-1.5 text-sm font-medium capitalize ${
                  filter === f
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </fieldset>

        {tasks.isLoading ? (
          <LoadingState label="Loading tasks" rows={5} />
        ) : tasks.isError ? (
          <ErrorState
            description="Demo task list failed to load."
            onRetry={() => void tasks.refetch()}
          />
        ) : list.length === 0 ? (
          <EmptyState
            title="No tasks in this view"
            description="Change the status filter to see other follow-ups."
          />
        ) : (
          <ul className="space-y-2">
            {list.map((task) => (
              <li
                key={task.id}
                className="rounded-md border border-border bg-card p-3 sm:flex sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{task.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {task.vendorId ? (
                      <Link
                        to="/dashboard/vendors/$vendorId"
                        params={{ vendorId: task.vendorId }}
                        className="focusable text-primary underline"
                      >
                        {task.vendorName}
                      </Link>
                    ) : (
                      task.vendorName
                    )}{" "}
                    · owner {task.owner}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 sm:mt-0">
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold uppercase ${priorityStyles[task.priority]}`}
                  >
                    {task.priority}
                  </span>
                  <span className="numeric text-xs text-muted-foreground">Due {task.dueOn}</span>
                  <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] uppercase">
                    {task.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
