import { cn } from "@band/ui";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

import type { TaskMap } from "./task-state";

export function TaskListWidget({ tasks }: { tasks: TaskMap }) {
  if (tasks.size === 0) return null;

  const taskList = Array.from(tasks.values());
  const completedCount = taskList.filter((t) => t.status === "completed").length;

  return (
    <div className="not-prose mb-4 w-full rounded border border-border/50">
      <div className="flex items-center justify-between gap-2 p-3">
        <span className="font-medium text-base">Tasks</span>
        <span className="text-sm text-muted-foreground">
          {completedCount}/{taskList.length}
        </span>
      </div>
      <div className="border-t border-border/50 px-3 py-2">
        {taskList.map((task) => (
          <div key={task.id} className="flex items-center gap-2 py-1.5">
            <TaskStatusIcon status={task.status} />
            <span
              className={cn(
                "text-base",
                task.status === "completed" && "text-muted-foreground line-through",
              )}
            >
              {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-4 shrink-0 text-green-500" />;
    case "in_progress":
      return <Loader2 className="size-4 shrink-0 animate-spin text-orange-500" />;
    default:
      return <Circle className="size-4 shrink-0 text-muted-foreground" />;
  }
}
