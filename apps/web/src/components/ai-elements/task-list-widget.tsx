import { cn } from "@band-app/ui";
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import type { TaskMap } from "./task-state";

function readCollapsed(workspaceId: string): boolean {
  try {
    return sessionStorage.getItem(`band-tasks-collapsed:${workspaceId}`) === "true";
  } catch {
    return false;
  }
}

export function TaskListWidget({ tasks, workspaceId }: { tasks: TaskMap; workspaceId: string }) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(workspaceId));
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        if (next) {
          sessionStorage.setItem(`band-tasks-collapsed:${workspaceId}`, "true");
        } else {
          sessionStorage.removeItem(`band-tasks-collapsed:${workspaceId}`);
        }
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, [workspaceId]);

  if (tasks.size === 0) return null;

  const taskList = Array.from(tasks.values());
  const allDone = taskList.every((t) => t.status === "completed");
  if (allDone) return null;
  const completedCount = taskList.filter((t) => t.status === "completed").length;

  return (
    <div
      data-testid="task-list-widget__container"
      className="not-prose mb-2 w-full rounded border border-border/50"
    >
      <button
        type="button"
        onClick={toggleCollapsed}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 transition-colors hover:bg-accent/50"
      >
        <div className="flex items-center gap-1.5">
          {collapsed ? (
            <ChevronRight className="size-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">Todos</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {completedCount}/{taskList.length}
        </span>
      </button>
      {!collapsed && (
        <div className="border-t border-border/50 px-2.5 py-1">
          {taskList.map((task) => (
            <div key={task.id} className="flex items-center gap-1.5 py-0.5">
              <TaskStatusIcon status={task.status} />
              <span
                className={cn(
                  "text-xs",
                  task.status === "completed" && "text-muted-foreground line-through",
                )}
              >
                {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-3 shrink-0 text-green-500" />;
    case "in_progress":
      return <Loader2 className="size-3 shrink-0 animate-spin text-orange-500" />;
    default:
      return <Circle className="size-3 shrink-0 text-muted-foreground" />;
  }
}
