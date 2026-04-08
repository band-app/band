import { createFileRoute } from "@tanstack/react-router";
import { TasksPageContent } from "../components/TasksPageContent";
import { TauriTitleBar } from "../components/TauriTitleBar";
import { isTauri } from "../lib/is-tauri";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});

function TasksPage() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]">
      {isTauri && <TauriTitleBar title="Tasks" />}
      <TasksPageContent />
    </div>
  );
}
